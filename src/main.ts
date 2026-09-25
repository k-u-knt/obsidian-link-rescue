import {
	App, MarkdownView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, debounce, setIcon,
	setTooltip,
} from "obsidian";
import { around } from "monkey-around";
import { CloudEmbed, CloudHost, CloudPlaceholder, EmbedCreator, formatSize, gateMediaEmbed } from "./cloudEmbed";
import { DiagnosticsModal } from "./diagnostics";
import { ICloud } from "./icloud";
import { IosCloud, isHiddenPath } from "./icloudIos";
import {
	LinkEdit, NameIndex, applyEdits, basename, dirname, isClickToCreateStub, normalizeKey, obsidianLinktext, pickCandidate,
	rewriteLinkpath, splitSubpath,
} from "./matching";

type DownloadMode = "auto" | "manual";

interface LinkRescueSettings {
	/** Repair a note's broken links automatically when it is opened. */
	autoRepair: boolean;
	/** macOS: download iCloud-only files as soon as a note shows them ("auto"), or only when clicked ("manual"). */
	downloadMode: DownloadMode;
	/** Show a message when files have been downloaded from iCloud. */
	notifyDownloads: boolean;
	showBadges: boolean;
	/** Opening a broken link that matches a file opens that file (and repairs the link) instead of creating an empty note. */
	safeOpen: boolean;
}

const DEFAULT_SETTINGS: LinkRescueSettings = {
	autoRepair: true,
	downloadMode: "auto",
	notifyDownloads: true,
	showBadges: true,
	safeOpen: true,
};

/**
 * Rendered links/embeds Obsidian couldn't resolve (Obsidian 1.13). Embeds of notes and other creatable files
 * get `.mod-empty` ("… is not created yet. Click to create."); attachments such as images get
 * `.mod-empty-attachment` ("… could not be found."). Once the link resolves Obsidian removes `.file-embed`,
 * so requiring it keeps us off embeds that have since loaded. Unresolved links in Live Preview are
 * CodeMirror-managed spans without the link text, so they are handled by the openLinkText hook instead.
 */
const BROKEN_SELECTOR = [
	".internal-embed.file-embed.mod-empty[src]",
	".internal-embed.file-embed.mod-empty-attachment[src]",
	"a.internal-link.is-unresolved[data-href]",
].join(", ");
const IMAGE_EXTENSIONS = ["bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif"];
/** Embed types Obsidian renders from the file's data (Obsidian 1.13 embedRegistry), which iCloud may have evicted. */
const CLOUD_EMBED_EXTENSIONS = [
	...IMAGE_EXTENSIONS,
	"mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus",
	"mp4", "webm", "ogv", "mov", "mkv",
	"pdf",
];

type BadgeState = "repair" | "repair-cloud" | "ambiguous" | "missing" | "failed";

const BADGE_ICONS: Record<BadgeState, string> = {
	repair: "link",
	"repair-cloud": "cloud-download",
	ambiguous: "files",
	missing: "cloud-off",
	failed: "alert-triangle",
};

type Resolution =
	| { kind: "ok" }
	/** Exactly one file matches once lookalike characters are ignored; rewrite the link to its name. */
	| { kind: "relink"; target: string }
	/** iOS/iPadOS: the file exists in iCloud but isn't downloaded to this device (only a placeholder). */
	| { kind: "cloud"; target: string }
	| { kind: "ambiguous"; candidates: string[] }
	| { kind: "missing" };

export default class LinkRescuePlugin extends Plugin implements CloudHost {
	settings: LinkRescueSettings = DEFAULT_SETTINGS;
	index = new NameIndex();
	icloud!: ICloud;
	iosCloud!: IosCloud;
	private brokenIndex: Map<string, string[]> | null = null;
	private unloaded = false;
	private timers = new Set<number>();
	private datalessCache = new Map<string, { value: boolean; at: number }>();
	private placeholders = new Set<CloudPlaceholder>();
	private reportedNotes = new Set<string>();
	private downloads = new Map<string, Promise<void>>();
	private downloaded = { count: 0, bytes: 0 };
	private statusEl: HTMLElement | null = null;

	async onload() {
		await this.loadSettings();
		this.icloud = new ICloud(this.app);
		this.iosCloud = new IosCloud(this.app);
		// Start looking for iCloud placeholders right away: until it's done, following a link could create an
		// empty note over a file that is only in iCloud.
		if (this.iosCloud.available) this.iosCloud.scan();
		this.addSettingTab(new LinkRescueSettingTab(this.app, this));
		this.patchOpenLinkText();
		// Before layout-ready, so the embeds of the first notes shown go through it too.
		this.patchEmbeds();
		if (this.icloud.available) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("link-rescue-status");
			this.statusEl.hide();
		}

		const rebuild = debounce(() => this.rebuildIndex(), 300, true);
		this.app.workspace.onLayoutReady(() => {
			this.rebuildIndex();
			// Registered after layout-ready so the initial vault load doesn't fire "create" for every file.
			this.registerEvent(this.app.vault.on("create", rebuild));
			this.registerEvent(this.app.vault.on("delete", rebuild));
			this.registerEvent(this.app.vault.on("rename", rebuild));
			this.registerEvent(this.app.workspace.on("file-open", (f) => {
				this.autoRepair(f);
				this.reportCloudFiles(f);
			}));
			this.autoRepair(this.app.workspace.getActiveFile());
			this.observeDom();
			// Lookup of which notes contain which broken links; rebuilt when links change.
			const invalidate = () => { this.brokenIndex = null; };
			this.registerEvent(this.app.metadataCache.on("resolved", invalidate));
			this.registerEvent(this.app.metadataCache.on("changed", invalidate));
			this.setupIosCloud();
		});

		this.addCommand({
			id: "icloud-diagnostics",
			name: "iCloud diagnostics (iPhone/iPad test)",
			checkCallback: (checking) => {
				if (!Platform.isMobileApp) return false;
				if (!checking) new DiagnosticsModal(this.app, this.iosCloud).open();
				return true;
			},
		});
		this.addCommand({
			id: "rescan-icloud-placeholders",
			name: "Rescan files not downloaded from iCloud (iPhone/iPad)",
			checkCallback: (checking) => {
				if (!this.iosCloud.available) return false;
				if (!checking) this.iosCloud.scan().then(() => {
					new Notice(`Link Rescue: ${this.iosCloud.size} file${this.iosCloud.size === 1 ? " is" : "s are"} ` +
						"in iCloud but not downloaded on this device.");
					this.redecorate();
				});
				return true;
			},
		});
		this.addCommand({
			id: "download-note-icloud-files",
			name: "Download cloud files embedded in current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!this.icloud.available || !file || file.extension !== "md") return false;
				if (!checking) this.downloadEmbedsOf(file);
				return true;
			},
		});
		this.addCommand({
			id: "toggle-auto-download",
			name: "Switch cloud downloads between automatic and manual",
			checkCallback: (checking) => {
				if (!this.icloud.available) return false;
				if (!checking) this.setDownloadMode(this.settings.downloadMode === "auto" ? "manual" : "auto");
				return true;
			},
		});

		this.addCommand({
			id: "repair-current-note",
			name: "Repair broken links in current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== "md") return false;
				if (!checking) this.iosCloud.ready.then(() => this.repairNote(file, { reportNone: true }));
				return true;
			},
		});
		this.addCommand({
			id: "scan-vault",
			name: "Find and repair broken links in vault",
			callback: () => new ScanModal(this.app, this).open(),
		});
	}

	onunload() {
		this.unloaded = true;
		this.timers.forEach((id) => window.clearTimeout(id));
		// Don't download everything at once on disable: leave the placeholders inert until the note is reopened.
		[...this.placeholders].forEach((p) => p.retire("Link Rescue was turned off. Reopen the note to show this file."));
		this.placeholders.clear();
		document.querySelectorAll(".link-rescue-badge").forEach((b) => b.remove());
		document.querySelectorAll<HTMLElement>("[data-link-rescue]").forEach((el) => {
			el.removeClass("link-rescue-host");
			delete el.dataset.linkRescue;
		});
	}

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		this.settings = {
			autoRepair: data.autoRepair ?? DEFAULT_SETTINGS.autoRepair,
			downloadMode: data.downloadMode === "manual" || data.downloadMode === "auto"
				? data.downloadMode
				: data.autoDownload === false ? "manual" : DEFAULT_SETTINGS.downloadMode,
			notifyDownloads: data.notifyDownloads ?? DEFAULT_SETTINGS.notifyDownloads,
			showBadges: data.showBadges ?? DEFAULT_SETTINGS.showBadges,
			safeOpen: data.safeOpen ?? data.interceptCreate ?? DEFAULT_SETTINGS.safeOpen,
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	rebuildIndex() {
		this.index = new NameIndex(this.app.vault.getFiles().map((f) => f.path));
	}

	/**
	 * Every way of following a link (click, Cmd-click, middle-click, keyboard, context menu, iOS tap)
	 * ends in WorkspaceLeaf.openLinkText, which creates an empty note when the link doesn't resolve.
	 * If the link only fails because of lookalike characters, open the real file and repair the link instead.
	 */
	private patchOpenLinkText() {
		const plugin = this;
		type OpenLinkText = (this: WorkspaceLeaf, linktext: string, sourcePath: string, ...rest: unknown[]) => Promise<void>;
		this.register(around(WorkspaceLeaf.prototype as unknown as { openLinkText: OpenLinkText }, {
			openLinkText(next: OpenLinkText): OpenLinkText {
				return function (this: WorkspaceLeaf, linktext: string, sourcePath: string, ...rest: unknown[]) {
					const ios = plugin.iosCloud.available;
					if (plugin.unloaded || typeof linktext !== "string" || (!plugin.settings.safeOpen && !ios)) {
						return next.call(this, linktext, sourcePath, ...rest);
					}
					const { path, subpath } = splitSubpath(linktext);
					const source = sourcePath ?? "";
					const decide = (res: Resolution): Promise<void> => {
						// The iCloud guard is always on; the lookalike handling follows the setting.
						if (res.kind === "cloud") {
							// Opening would create an empty file with the same name as the one waiting in iCloud.
							new Notice(cloudMessage(res.target), 10000);
							return Promise.resolve();
						}
						if (plugin.settings.safeOpen && res.kind === "relink") {
							plugin.repairSources(path, [sourcePath], { quiet: false });
							return next.call(this, res.target + subpath, sourcePath, ...rest);
						}
						if (plugin.settings.safeOpen && res.kind === "ambiguous") {
							new Notice(`Link Rescue: not creating "${path}" because several files match:\n${res.candidates.join("\n")}`);
							return Promise.resolve();
						}
						return next.call(this, linktext, sourcePath, ...rest);
					};
					const res = plugin.resolve(path, source);
					if (res.kind === "ok" || !ios) return decide(res);
					// iPhone/iPad: until we know which files are only in iCloud, and before Obsidian creates a note for a
					// "missing" link, make sure the file isn't just not downloaded here.
					return (async () => {
						if (!plugin.iosCloud.scanned) {
							const ready = await Promise.race([plugin.iosCloud.ready.then(() => true), sleep(5000).then(() => false)]);
							if (!ready) {
								new Notice("Link Rescue: still checking which files are only in iCloud. Try again in a moment.");
								return;
							}
						}
						const again = plugin.resolve(path, source);
						if (again.kind === "missing") {
							const cloudPath = await plugin.placeholderWhereCreated(path, source);
							if (cloudPath) {
								new Notice(cloudMessage(cloudPath), 10000);
								return;
							}
						}
						return decide(again);
					})();
				};
			},
		}));
	}

	/**
	 * Obsidian renders image/PDF/audio/video embeds through `app.embedRegistry` creators, whose loadFile()
	 * reads the file, and a read of an iCloud-only file silently downloads it. Wrap those creators so an
	 * iCloud-only file first shows a placeholder with its download state (and in manual mode waits for a click).
	 */
	private patchEmbeds() {
		const registry = (this.app as unknown as { embedRegistry?: { embedByExtension?: Record<string, EmbedCreator> } })
			.embedRegistry?.embedByExtension;
		if (!registry || !this.icloud.available) return;
		for (const ext of CLOUD_EMBED_EXTENSIONS) {
			const original = registry[ext];
			if (typeof original !== "function") continue;
			const wrapped: EmbedCreator = (ctx, file, subpath) => {
				if (this.unloaded || !(file instanceof TFile) || !this.icloud.isDatalessSync(file.path)) {
					return original(ctx, file, subpath);
				}
				// PDFs build their viewer inside the container, so they get a stand-in that is swapped later.
				if (ext === "pdf") return new CloudEmbed(this, ctx, file, () => original(ctx, file, subpath));
				// Images, audio, video: keep Obsidian's own embed and defer only its loading.
				const real = original(ctx, file, subpath);
				if (real && typeof real.loadFile === "function") {
					gateMediaEmbed(this, ctx, file, real, IMAGE_EXTENSIONS.includes(ext),
						() => !this.unloaded && this.icloud.isDatalessSync(file.path),
						() => this.app.vault.getResourcePath(file));
				}
				return real;
			};
			registry[ext] = wrapped;
			// Restore only if nobody has replaced our wrapper since.
			this.register(() => { if (registry[ext] === wrapped) registry[ext] = original; });
		}
	}

	get autoDownload(): boolean {
		return this.settings.downloadMode === "auto";
	}

	get cloudName(): string {
		return this.icloud.cloudName;
	}

	track(p: CloudPlaceholder) {
		this.placeholders.add(p);
	}

	untrack(p: CloudPlaceholder) {
		this.placeholders.delete(p);
	}

	/** Placeholders still waiting for their file (dropping ones whose embed left the page without unloading). */
	private pendingPlaceholders(): CloudPlaceholder[] {
		for (const p of this.placeholders) if (!p.containerEl.isConnected && !p.downloading) this.placeholders.delete(p);
		return [...this.placeholders].filter((p) => p.pending);
	}

	async setDownloadMode(mode: DownloadMode) {
		this.settings.downloadMode = mode;
		await this.saveSettings();
		// Placeholders already on screen follow the new mode right away.
		const waiting = this.pendingPlaceholders();
		if (mode === "auto") waiting.forEach((p) => p.start());
		const files = new Set(waiting.map((p) => p.file.path)).size;
		const where = this.cloudName;
		new Notice(mode === "auto"
			? `Link Rescue: ${where} downloads are automatic.${files ? ` Downloading ${files} file${files === 1 ? "" : "s"} now…` : ""}`
			: `Link Rescue: ${where} downloads are manual. Files still in ${where} show a placeholder; click it to download.`);
	}

	/** In manual mode, say once per note how many of its files are still only in the cloud. */
	private reportCloudFiles(note: TFile | null) {
		if (!note || note.extension !== "md" || !this.icloud.available || this.autoDownload) return;
		if (this.reportedNotes.has(note.path)) return;
		// After the embeds have been created (placeholders register themselves as they load).
		this.later(() => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view || view.file !== note) return;
			const files = new Set(this.pendingPlaceholders()
				.filter((p) => view.containerEl.contains(p.containerEl))
				.map((p) => p.file.path));
			const n = files.size;
			if (!n) return;
			this.reportedNotes.add(note.path);
			new Notice(`Link Rescue: ${n} file${n === 1 ? " shown in this note is" : "s shown in this note are"} only in ` +
				`${this.cloudName}. Click one to download it, or run "Download cloud files embedded in current note".`, 8000);
		}, 800);
	}

	/** Download an iCloud-only file, once however many embeds ask, then show it everywhere it's embedded. */
	download(file: TFile): Promise<void> {
		const existing = this.downloads.get(file.path);
		if (existing) return existing;
		const p = (async () => {
			this.updateStatus();
			await this.icloud.download(file.path);
			this.datalessCache.delete(file.path);
			this.downloaded.count++;
			this.downloaded.bytes += file.stat.size;
			this.notifyDownloaded();
			for (const p of [...this.placeholders]) if (p.file === file) p.finish();
		})().finally(() => {
			this.downloads.delete(file.path);
			this.updateStatus();
		});
		this.downloads.set(file.path, p);
		this.updateStatus();
		return p;
	}

	/** Download every iCloud-only file the note embeds. */
	async downloadEmbedsOf(note: TFile) {
		const cache = this.app.metadataCache.getFileCache(note);
		const files = new Set<TFile>();
		for (const ref of cache?.embeds ?? []) {
			const f = this.app.metadataCache.getFirstLinkpathDest(obsidianLinktext(splitSubpath(ref.link).path), note.path);
			if (f && f.extension !== "md") files.add(f);
		}
		const cloud = [...files].filter((f) => this.icloud.isDatalessSync(f.path));
		if (!cloud.length) {
			new Notice(`Link Rescue: all ${files.size} embedded file${files.size === 1 ? " is" : "s are"} already downloaded.`);
			return;
		}
		new Notice(`Link Rescue: downloading ${cloud.length} file${cloud.length === 1 ? "" : "s"} from ${this.cloudName}…`);
		const results = await Promise.allSettled(cloud.map((f) => this.download(f)));
		const failed = results.filter((r) => r.status === "rejected").length;
		if (failed) new Notice(`Link Rescue: ${failed} download${failed === 1 ? "" : "s"} failed. See the developer console.`);
	}

	private updateStatus() {
		if (!this.statusEl) return;
		const n = this.downloads.size;
		if (!n) {
			this.statusEl.hide();
			return;
		}
		this.statusEl.show();
		this.statusEl.empty();
		setIcon(this.statusEl.createSpan({ cls: "link-rescue-status-icon" }), "loader");
		this.statusEl.createSpan({ text: ` Downloading ${n} from ${this.cloudName}…` });
	}

	/** One message per burst of downloads, e.g. "downloaded 7 files from iCloud (412 KB)". */
	private notifyDownloaded = debounce(() => {
		const { count, bytes } = this.downloaded;
		this.downloaded = { count: 0, bytes: 0 };
		if (!count || this.unloaded || !this.settings.notifyDownloads) return;
		new Notice(`Link Rescue: downloaded ${count} file${count === 1 ? "" : "s"} from ${this.cloudName} (${formatSize(bytes)}).`);
	}, 1500, true);

	/** The real path of an iCloud placeholder where Obsidian would create the file for this link, if any. */
	async placeholderWhereCreated(linkpath: string, sourcePath: string): Promise<string | null> {
		const link = obsidianLinktext(linkpath);
		const name = basename(link);
		const names = name.includes(".") ? [name, `${name}.md`] : [`${name}.md`];
		let folder = dirname(link);
		if (!link.includes("/")) {
			const parent = this.app.fileManager.getNewFileParent(sourcePath);
			folder = !parent || parent.path === "/" ? "" : parent.path;
		}
		for (const n of names) {
			if (await this.iosCloud.hasPlaceholder(folder, n)) {
				this.iosCloud.rescanFolder(folder).then(() => this.redecorate());
				return folder ? `${folder}/${n}` : n;
			}
		}
		return null;
	}

	/** Placeholders vanished (downloaded): if Obsidian didn't notice the real file, ask it to look again. */
	private async nudge(gone: string[]) {
		const update = (this.app.vault.adapter as unknown as { update?: (p: string) => Promise<void> }).update;
		if (typeof update !== "function") return;
		for (const real of gone) {
			// Only Obsidian-normalized paths: passing an on-disk name with U+202F would create a duplicate entry.
			if (!this.app.vault.getAbstractFileByPath(real)) await update.call(this.app.vault.adapter, real).catch(() => undefined);
		}
	}

	/** iPhone/iPad: keep the placeholder index current so "not downloaded here" isn't mistaken for "missing". */
	private setupIosCloud() {
		if (!this.iosCloud.available) return;
		this.iosCloud.ready.then(() => this.redecorate());
		const redecorateSoon = debounce(() => this.redecorate(), 300, true);
		this.registerEvent(this.app.vault.on("create", (f) => {
			if (this.iosCloud.forget(f.path)) redecorateSoon();
		}));
		// Undocumented, but fired by the adapter for every path it sees, including hidden placeholders.
		const pending = new Set<string>();
		const flush = debounce(async () => {
			const folders = [...pending];
			pending.clear();
			for (const folder of folders) await this.nudge(await this.iosCloud.rescanFolder(folder));
			this.redecorate();
		}, 500, true);
		const vault = this.app.vault as unknown as { on(name: "raw", cb: (path: string) => void): import("obsidian").EventRef };
		this.registerEvent(vault.on("raw", (path: string) => {
			if (typeof path !== "string" || !path.endsWith(".icloud") || isHiddenPath(dirname(path))) return;
			pending.add(dirname(path));
			flush();
		}));
		// Coming back from the Files app (where the user may have downloaded files): rescan, but not constantly.
		let hiddenAt = 0;
		let lastScan = Date.now();
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				return;
			}
			// Ignore quick app switches and back-to-back returns; a trip to the Files app takes longer.
			if (Date.now() - hiddenAt < 5000 || Date.now() - lastScan < 15000) return;
			lastScan = Date.now();
			this.iosCloud.scan().then(async (gone) => {
				await this.nudge(gone);
				this.redecorate();
			});
		});
	}

	/** Re-evaluate every broken link/embed on screen (e.g. after the placeholder index changed). */
	private redecorate() {
		if (this.unloaded) return;
		// Drop badges whose link or embed has since resolved.
		document.querySelectorAll<HTMLElement>(".link-rescue-badge").forEach((badge) => {
			const host = badge.parentElement?.hasClass("link-rescue-host") ? badge.parentElement : badge.previousElementSibling;
			if (!(host instanceof HTMLElement) || !host.matches(BROKEN_SELECTOR)) {
				badge.remove();
				if (host instanceof HTMLElement) host.removeClass("link-rescue-host");
			}
		});
		document.querySelectorAll<HTMLElement>("[data-link-rescue]").forEach((el) => delete el.dataset.linkRescue);
		this.decorate();
	}

	private autoRepair(file: TFile | null) {
		if (!file || file.extension !== "md" || !this.settings.autoRepair) return;
		// On iPhone/iPad, wait until we know which files are only in iCloud, so they aren't "repaired" away.
		this.iosCloud.ready.then(() => this.repairNote(file, {}));
	}

	/** Work out why a link doesn't resolve and what would fix it. */
	resolve(linkpath: string, sourcePath: string): Resolution {
		const link = obsidianLinktext(linkpath);
		if (!link || this.app.metadataCache.getFirstLinkpathDest(link, sourcePath)) return { kind: "ok" };
		// iPhone/iPad: not downloaded on this device isn't broken; never "repair" or create over it.
		if (this.iosCloud.available) {
			// Drop stale entries for files that have arrived since.
			const cloud = this.iosCloud.index.find(link).filter((p) => {
				if (!this.app.vault.getAbstractFileByPath(p)) return true;
				this.iosCloud.forget(p);
				return false;
			});
			if (cloud.length) return { kind: "cloud", target: pickCandidate(cloud, sourcePath) ?? cloud[0] };
		}
		// Never point a link at an empty note that "Click to create" made.
		const candidates = this.index.find(link).filter((c) => !this.isStub(c));
		const target = pickCandidate(candidates, sourcePath);
		if (target) return { kind: "relink", target };
		return candidates.length ? { kind: "ambiguous", candidates } : { kind: "missing" };
	}

	private isStub(path: string): boolean {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile && isClickToCreateStub(file.path, file.stat.size);
	}

	/** Link edits that would repair a note's broken links (optionally only those to `onlyLinkpath`). */
	planRepairs(file: TFile, onlyLinkpath?: string): LinkEdit[] {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache) return [];
		const only = onlyLinkpath === undefined ? null : normalizeKey(onlyLinkpath);
		const edits: LinkEdit[] = [];
		for (const ref of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
			const { path: linkpath } = splitSubpath(ref.link);
			if (only !== null && normalizeKey(linkpath) !== only) continue;
			const res = this.resolve(linkpath, file.path);
			if (res.kind !== "relink") continue;
			const newLinkpath = rewriteLinkpath(linkpath, res.target);
			if (newLinkpath === linkpath) continue;
			edits.push({
				start: ref.position.start.offset,
				end: ref.position.end.offset,
				original: ref.original,
				oldLinkpath: linkpath,
				newLinkpath,
			});
		}
		return edits;
	}

	/** Rewrite a note's broken links to the exact names of the files they mean. Returns how many changed. */
	async repairNote(
		file: TFile,
		opts: { onlyLinkpath?: string; quiet?: boolean; reportNone?: boolean } = {},
	): Promise<number> {
		if (this.unloaded || file.extension !== "md") return 0;
		const edits = this.planRepairs(file, opts.onlyLinkpath);
		let applied = 0;
		if (edits.length) {
			await this.app.vault.process(file, (text) => {
				const out = applyEdits(text, edits);
				applied = out.applied;
				return out.text;
			});
		}
		if (!opts.quiet) {
			if (applied) new Notice(`Link Rescue: repaired ${applied} link${applied === 1 ? "" : "s"} in "${file.basename}".`);
			else if (opts.reportNone) new Notice("Link Rescue: nothing to repair in this note.");
		}
		return applied;
	}

	/**
	 * Repair a broken link in the note(s) that actually contain it. `hints` are the notes it was probably
	 * seen in; if none of them contains it (e.g. it was inside an embedded note or a hover popover), every
	 * note with the same broken link is repaired.
	 */
	async repairSources(linkpath: string, hints: Array<string | null | undefined>, opts: { quiet?: boolean } = {}): Promise<number> {
		const sources = this.notesWithBrokenLink(linkpath);
		const hinted = hints.filter((h): h is string => !!h && sources.includes(h));
		let n = 0;
		for (const source of hinted.length ? hinted.slice(0, 1) : sources) {
			const file = this.app.vault.getAbstractFileByPath(source);
			if (file instanceof TFile) n += await this.repairNote(file, { onlyLinkpath: linkpath, quiet: opts.quiet });
		}
		return n;
	}

	/** Notes whose unresolved links include `linkpath` (compared ignoring lookalike characters). */
	notesWithBrokenLink(linkpath: string): string[] {
		if (!this.brokenIndex) {
			const index = new Map<string, string[]>();
			for (const [source, links] of Object.entries(this.app.metadataCache.unresolvedLinks)) {
				for (const l of Object.keys(links)) {
					const k = normalizeKey(l);
					const list = index.get(k);
					if (!list) index.set(k, [source]);
					else if (!list.includes(source)) list.push(source);
				}
			}
			this.brokenIndex = index;
		}
		return [...(this.brokenIndex.get(normalizeKey(splitSubpath(linkpath).path)) ?? [])];
	}

	async isDataless(path: string): Promise<boolean> {
		const hit = this.datalessCache.get(path);
		if (hit && Date.now() - hit.at < 5000) return hit.value;
		const value = await this.icloud.isDataless(path);
		this.datalessCache.set(path, { value, at: Date.now() });
		return value;
	}

	// ---- Badges on rendered notes (reading view and Live Preview) ----

	private observeDom() {
		let scheduled = false;
		const schedule = () => {
			if (scheduled || this.unloaded) return;
			scheduled = true;
			window.requestAnimationFrame(() => { scheduled = false; if (!this.unloaded) this.decorate(); });
		};
		const observer = new MutationObserver(schedule);
		// document.body rather than the workspace, so hover popovers are covered too (not on phones: cheaper).
		observer.observe(Platform.isMobile ? this.app.workspace.containerEl : document.body, { childList: true, subtree: true });
		this.register(() => observer.disconnect());
		schedule();
	}

	private decorate() {
		document.querySelectorAll<HTMLElement>(BROKEN_SELECTOR).forEach((el) => this.decorateBroken(el));
	}

	private decorateBroken(el: HTMLElement) {
		const link = linkOf(el);
		if (!link || el.dataset.linkRescue === link) return;
		el.dataset.linkRescue = link;
		const { path } = splitSubpath(link);
		const source = this.sourceFor(el, path);
		const res = this.resolve(path, source ?? "");
		switch (res.kind) {
			case "ok":
				this.badgeOf(el)?.remove();
				return;
			case "relink":
				this.isDataless(res.target).then((cloud) => this.setBadge(el, cloud ? "repair-cloud" : "repair",
					`Found "${res.target}"${cloud ? " (in iCloud)" : ""}. Its name differs from this link only by an ` +
					`invisible character. Click to fix the link.`,
					() => this.fixElement(el, path, source)));
				return;
			case "cloud":
				this.setBadge(el, "repair-cloud", cloudMessage(res.target), () => new Notice(cloudMessage(res.target), 10000));
				return;
			case "ambiguous":
				this.setBadge(el, "ambiguous", `Several files match:\n${res.candidates.join("\n")}\nRename or move one so the link is unambiguous.`);
				return;
			case "missing":
				if (el.matches(".internal-embed")) this.setBadge(el, "missing", "No matching file in this vault.");
				else this.badgeOf(el)?.remove();
		}
	}

	private async fixElement(el: HTMLElement, linkpath: string, source: string | null) {
		const n = await this.repairSources(linkpath, [source, this.app.workspace.getActiveFile()?.path]);
		if (!n && el.isConnected && !this.unloaded) {
			this.setBadge(el, "failed", "Couldn't repair this link. The note may have changed; try again.",
				() => this.fixElement(el, linkpath, source));
		}
	}

	private badgeOf(el: HTMLElement): HTMLElement | null {
		const inside = el.querySelector<HTMLElement>(":scope > .link-rescue-badge");
		if (inside) return inside;
		const next = el.nextElementSibling;
		return next instanceof HTMLElement && next.hasClass("link-rescue-badge") ? next : null;
	}

	private setBadge(el: HTMLElement, state: BadgeState, tooltip: string, onClick?: () => void) {
		if (this.unloaded || !el.isConnected) return;
		if (!this.settings.showBadges) return;
		let badge = this.badgeOf(el) as BadgeEl | null;
		if (!badge) {
			const b = createSpan({ cls: "link-rescue-badge" }) as BadgeEl;
			if (el.tagName === "A") el.insertAdjacentElement("afterend", b);
			else {
				el.addClass("link-rescue-host");
				el.appendChild(b);
			}
			// Keep clicks on the badge away from Obsidian's own handlers on the embed/link.
			const onBadge = (evt: MouseEvent) => {
				evt.preventDefault();
				evt.stopPropagation();
				if (evt.type === "click") b._linkRescueClick?.();
			};
			b.addEventListener("click", onBadge);
			b.addEventListener("mousedown", onBadge);
			b.addEventListener("auxclick", onBadge);
			badge = b;
		}
		// Touch screens don't show tooltips, so a tap shows the explanation instead.
		badge._linkRescueClick = onClick ?? (Platform.isMobile ? () => new Notice(tooltip, 8000) : undefined);
		badge.className = `link-rescue-badge is-${state}${onClick ? " is-clickable" : ""}`;
		badge.empty();
		setIcon(badge, BADGE_ICONS[state]);
		setTooltip(badge, tooltip);
	}

	/**
	 * The note a rendered element most likely belongs to: the note that contains this broken link,
	 * checking the view the element is in, then the active note.
	 */
	private sourceFor(el: HTMLElement, linkpath: string | null): string | null {
		let viewFile: string | null = null;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.containerEl.contains(el)) viewFile = view.file?.path ?? null;
		}
		const active = this.app.workspace.getActiveFile()?.path ?? null;
		if (linkpath === null) return viewFile ?? active;
		const sources = this.notesWithBrokenLink(linkpath);
		for (const hint of [viewFile, active]) if (hint && sources.includes(hint)) return hint;
		return sources[0] ?? viewFile ?? active;
	}

	/** setTimeout that doesn't fire after the plugin is unloaded. */
	private later(fn: () => void, ms: number) {
		const id = window.setTimeout(() => {
			this.timers.delete(id);
			if (!this.unloaded) fn();
		}, ms);
		this.timers.add(id);
	}
}

type BadgeEl = HTMLElement & { _linkRescueClick?: () => void };

/** What to tell the user about a file that's in iCloud but not downloaded on this iPhone/iPad. */
function cloudMessage(path: string): string {
	return `"${basename(path)}" is in iCloud but not downloaded on this device. To get it, open the Files app → ` +
		`iCloud Drive → Obsidian → your vault${dirname(path) ? ` → ${dirname(path)}` : ""} and tap the file, then come back. ` +
		`Tip: long-press the vault folder in Files and choose "Keep Downloaded".`;
}

/** Link text of a rendered link/embed element (the raw link path; Obsidian doesn't URL-encode it). */
function linkOf(el: HTMLElement): string | null {
	return el.getAttribute("src") ?? el.getAttribute("data-href");
}

class ScanModal extends Modal {
	constructor(app: App, private plugin: LinkRescuePlugin) {
		super(app);
	}

	onOpen() {
		this.setTitle("Link Rescue");
		if (this.plugin.iosCloud.scanned) return this.render();
		this.contentEl.setText("Checking which files are only in iCloud…");
		this.plugin.iosCloud.ready.then(() => { if (this.contentEl.isConnected) this.render(); });
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		const { vault, metadataCache } = this.app;

		const relinks = new Map<string, Array<{ linkpath: string; target: string }>>();
		let ambiguous = 0;
		let cloud = 0;
		for (const [source, links] of Object.entries(metadataCache.unresolvedLinks)) {
			for (const linkpath of Object.keys(links)) {
				const res = this.plugin.resolve(linkpath, source);
				if (res.kind === "relink") {
					if (!relinks.has(source)) relinks.set(source, []);
					relinks.get(source)!.push({ linkpath, target: res.target });
				} else if (res.kind === "ambiguous") ambiguous++;
				else if (res.kind === "cloud") cloud++;
			}
		}
		const total = [...relinks.values()].reduce((n, l) => n + l.length, 0);

		// Empty notes that "Click to create" made next to a real attachment.
		const stubs = vault.getMarkdownFiles().filter((f) =>
			isClickToCreateStub(f.path, f.stat.size) &&
			this.plugin.index.find(f.basename).some((p) => p !== f.path));

		if (!total && !stubs.length) {
			contentEl.createEl("p", { text: "Nothing to repair. No broken links match an existing file." });
		}

		this.section(
			`Links to repair (${total})`,
			"These links don't resolve only because they contain an invisible or lookalike character (for example " +
				"the narrow no-break space in macOS screenshot names). Repairing rewrites each link to the file's exact name.",
			[...relinks].flatMap(([source, items]) => [
				{ text: source, strong: true },
				...items.map(({ linkpath, target }) => ({ text: `${visible(linkpath)} → ${basename(target)}` })),
			]),
			total ? `Repair ${total} link${total === 1 ? "" : "s"} in ${relinks.size} note${relinks.size === 1 ? "" : "s"}` : null,
			async () => {
				let n = 0;
				for (const source of relinks.keys()) {
					const file = vault.getAbstractFileByPath(source);
					if (file instanceof TFile) n += await this.plugin.repairNote(file, { quiet: true });
				}
				new Notice(`Link Rescue: repaired ${n} link${n === 1 ? "" : "s"}.`);
			},
		);

		this.section(
			`Empty notes made by "Click to create" (${stubs.length})`,
			"Empty notes named after an attachment that exists elsewhere in the vault. They are moved to your system trash.",
			stubs.map((f) => ({ text: f.path })),
			stubs.length ? `Move ${stubs.length} to system trash` : null,
			async () => {
				for (const f of stubs) await vault.trash(f, true);
				new Notice(`Link Rescue: moved ${stubs.length} empty note${stubs.length === 1 ? "" : "s"} to the system trash.`);
			},
		);

		if (cloud) {
			contentEl.createEl("p", {
				cls: "link-rescue-scan-note-text",
				text: `${cloud} link${cloud === 1 ? " points" : "s point"} to files that are in iCloud but not downloaded on ` +
					"this device. They are left alone.",
			});
		}
		if (ambiguous) {
			contentEl.createEl("p", {
				cls: "link-rescue-scan-note-text",
				text: `${ambiguous} broken link${ambiguous === 1 ? "" : "s"} match several files and are left alone.`,
			});
		}
	}

	private section(
		title: string, desc: string, rows: Array<{ text: string; strong?: boolean }>, action: string | null, run: () => Promise<void>,
	) {
		if (!rows.length) return;
		const { contentEl } = this;
		contentEl.createEl("h4", { text: title });
		contentEl.createEl("p", { cls: "link-rescue-scan-note-text", text: desc });
		const list = contentEl.createDiv({ cls: "link-rescue-scan" });
		for (const r of rows) list.createDiv({ cls: r.strong ? "link-rescue-scan-source" : "link-rescue-scan-row", text: r.text });
		if (!action) return;
		new Setting(contentEl).addButton((b) =>
			b.setButtonText(action).setCta().onClick(async () => {
				b.setDisabled(true);
				await run();
				// Give the metadata cache a moment to catch up, then show what's left.
				window.setTimeout(() => { if (this.contentEl.isConnected) this.render(); }, 800);
			}),
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Show invisible characters in a link so the user can see what's wrong with it. */
function visible(s: string): string {
	return s.replace(/[\u00A0\u1680\u2000-\u200D\u202F\u205F\u2060\u3000\uFEFF]/g,
		(c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

class LinkRescueSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LinkRescuePlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		type ToggleKey = { [K in keyof LinkRescueSettings]: LinkRescueSettings[K] extends boolean ? K : never }[keyof LinkRescueSettings];
		const toggle = (key: ToggleKey, name: string, desc: string) =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
				t.setValue(this.plugin.settings[key]).onChange(async (v) => {
					this.plugin.settings[key] = v;
					await this.plugin.saveSettings();
				}),
			);
		toggle("autoRepair", "Repair links when a note opens",
			"When a link is broken only because of an invisible or lookalike character and exactly one file matches, " +
			"rewrite the link to that file's exact name.");
		toggle("safeOpen", "Open the matching file instead of creating an empty note",
			"When you follow such a link (click, keyboard or menu), open the real file and repair the link, " +
			"instead of Obsidian's \"Click to create\" making an empty note.");
		if (this.plugin.icloud.available) {
			new Setting(containerEl)
				.setName("iCloud downloads")
				.setDesc("For images, PDFs, audio and video that are still only in iCloud. Automatic: download as soon as a " +
					"note shows them. Manual: show a placeholder and download only when you click it.")
				.addDropdown((d) => d
					.addOption("auto", "Automatic")
					.addOption("manual", "Manual (click to download)")
					.setValue(this.plugin.settings.downloadMode)
					.onChange((v) => this.plugin.setDownloadMode(v as DownloadMode)));
			// `git status` (e.g. from the Git plugin) re-reads files whose stat changed, which downloads evicted files.
			this.app.vault.adapter.exists(".git").then((isRepo) => {
				if (!isRepo) return;
				containerEl.createEl("p", {
					cls: "link-rescue-scan-note-text",
					text: "This vault is a git repository. \"git status\" (for example from the Git plugin) reads files whose " +
						"iCloud state changed, which downloads them regardless of this setting. To stop that, run " +
						"\"git config core.checkStat minimal\" in the vault folder.",
				});
			});
		}
		if (this.plugin.icloud.available) toggle("notifyDownloads", "Notify about iCloud downloads",
			"Show a message when files have been downloaded from iCloud.");
		toggle("showBadges", "Show status icons",
			"Show a small icon on broken links and embeds, and on files that are still in iCloud.");
	}
}
