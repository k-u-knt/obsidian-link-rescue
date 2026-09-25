import { App, CapacitorAdapter, Modal, Notice, Platform, Setting, TFile, debounce } from "obsidian";
import { IosCloud, isHiddenPath } from "./icloudIos";
import { basename, dirname } from "./matching";

type AnyRecord = Record<string, unknown>;
type Probe = { real: string; rawName: string; placeholder: string };

const MAX_EVENT_LINES = 100;
const PLACEHOLDER = /^\.(.+)\.icloud$/;

/**
 * Device test for iCloud on iPhone/iPad. Records what the device actually shows (placeholders vs. real
 * files), which native file methods exist, and what each possible way of triggering a download does, and
 * writes it to a note (one per device and run) that syncs back to the other devices. It never deletes,
 * renames or writes anything except its own report.
 */
export class DiagnosticsModal extends Modal {
	private lines: string[] = [];
	private offs: Array<() => void> = [];
	private closed = false;
	private eventLines = 0;
	private reportPath: string | null = null;
	private saving: Promise<void> = Promise.resolve();
	private saveSoon = debounce(() => this.save(), 1500, true);
	private probes: Probe[] = [];

	constructor(app: App, private ios: IosCloud) {
		super(app);
	}

	async onOpen() {
		this.setTitle("Link Rescue: iCloud diagnostics");
		this.contentEl.setText("Running checks… The report is saved as a note after each step.");
		// Listen right away so nothing is missed and closing early always removes the listeners.
		this.watchEvents();
		this.log(`# Link Rescue diagnostics`, `Started ${new Date().toISOString()}`, "");
		this.environment();
		await this.placeholders();
		if (this.closed) return;
		await this.save();
		if (!this.closed) this.render();
	}

	onClose() {
		this.closed = true;
		this.offs.forEach((off) => off());
		this.offs = [];
		this.saveSoon.cancel();
		this.save();
		this.contentEl.empty();
	}

	private get adapter(): AnyRecord {
		return this.app.vault.adapter as unknown as AnyRecord;
	}

	private get nativeFs(): AnyRecord | undefined {
		return (window as unknown as { Capacitor?: { Plugins?: AnyRecord } }).Capacitor?.Plugins?.Filesystem as AnyRecord | undefined;
	}

	private folder(): string {
		const active = this.app.workspace.getActiveFile();
		return active ? dirname(active.path) : "";
	}

	private environment() {
		const fs = this.adapter.fs as AnyRecord | undefined;
		const headers = (window as unknown as { Capacitor?: { PluginHeaders?: Array<{ name: string; methods: Array<{ name: string }> }> } })
			.Capacitor?.PluginHeaders;
		const isCapacitor = typeof CapacitorAdapter === "function" && this.app.vault.adapter instanceof CapacitorAdapter;
		this.log("## Environment",
			`- iOS app: ${Platform.isIosApp}, mobile: ${Platform.isMobile}, tablet-sized window: ${Platform.isTablet}, phone: ${Platform.isPhone}`,
			`- user agent: \`${navigator.userAgent}\``,
			`- CapacitorAdapter: ${isCapacitor}, fs.dir: \`${String(fs?.dir)}\`, iCloud vault detected: ${this.ios.available}`,
			`- native Filesystem methods: ${headers?.find((p) => p.name === "Filesystem")?.methods.map((m) => m.name).join(", ") ?? "(unknown)"}`,
			"");
	}

	private async placeholders() {
		this.log("## Placeholders");
		// Our own walk, independent of the detection above, so a detection failure still shows what's on disk.
		const found: string[] = [];
		let failures = 0;
		const walk = async (folder: string) => {
			let listed;
			try {
				listed = await this.app.vault.adapter.list(folder || "/");
			} catch {
				try { listed = await this.app.vault.adapter.list(folder); } catch { failures++; return; }
			}
			for (const f of listed.files) if (PLACEHOLDER.test(basename(f)) && !isHiddenPath(dirname(f))) found.push(f);
			for (const sub of listed.folders) if (!isHiddenPath(sub) && !this.closed) await walk(sub);
		};
		await walk("");
		if (this.closed) return;
		await this.ios.scan();
		this.log(`- own walk: ${found.length} placeholder(s), ${failures} folder(s) couldn't be listed`,
			`- plugin index: ${this.ios.size} file(s) only in iCloud, ${this.ios.failures} listing failure(s)`);

		const folder = this.folder();
		this.log(`- folder of the active note: \`${folder || "/"}\``);
		const raw = await this.rawNames(folder);
		const inVault = new Set(this.app.vault.getFiles().filter((f) => dirname(f.path) === folder).map((f) => f.name));
		if (raw) {
			const hidden = raw.filter((n) => PLACEHOLDER.test(n));
			const unknown = raw.filter((n) => !n.startsWith(".") && !inVault.has(n.replace(/[  ]/g, " ").normalize("NFC")));
			this.log(`  - native listing: ${raw.length} entries, ${hidden.length} placeholder(s), ${inVault.size} known to Obsidian`);
			for (const n of hidden.slice(0, 20)) this.log(`    - \`${visible(n)}\``);
			if (unknown.length) this.log(`  - on disk but unknown to Obsidian (dataless?): ${unknown.slice(0, 20).map((n) => `\`${visible(n)}\``).join(", ")}`);
			this.probes = hidden.slice(0, 15).map((ph) => {
				const rawName = PLACEHOLDER.exec(ph)![1];
				return { rawName, placeholder: join(folder, ph), real: join(folder, rawName) };
			});
		} else {
			this.log("  - native listing unavailable; using the plugin's index (names normalized by Obsidian)");
			this.probes = this.ios.all().filter((p) => dirname(p.path) === folder).slice(0, 15)
				.map((p) => ({ real: p.path, rawName: basename(p.path), placeholder: p.placeholder }));
		}
		const first = this.probes[0];
		if (first) {
			this.log(`- sample: \`${visible(first.placeholder)}\``);
			await this.attempt("stat(placeholder)", () => this.app.vault.adapter.stat(first.placeholder));
			await this.attempt("stat(real name)", () => this.app.vault.adapter.stat(first.real));
		}
		this.log("");
	}

	/** Names exactly as on disk (Obsidian normalizes U+202F/U+00A0 in the names it reports). */
	private async rawNames(folder: string): Promise<string[] | null> {
		const fs = this.adapter.fs as { readdir?: (p: string) => Promise<Array<{ name: string } | string>> } | undefined;
		if (typeof fs?.readdir !== "function") return null;
		try {
			const entries = await fs.readdir(this.fullPath(folder));
			return entries.map((e) => (typeof e === "string" ? e : e.name));
		} catch (e) {
			this.log(`  - native readdir failed: \`${message(e)}\``);
			return null;
		}
	}

	private watchEvents() {
		const vault = this.app.vault as unknown as { on(name: string, cb: (...a: unknown[]) => void): unknown; offref(ref: unknown): void };
		for (const name of ["create", "raw"]) {
			const ref = vault.on(name, (arg: unknown) => {
				if (this.closed) return;
				const p = arg instanceof TFile ? arg.path : String(arg);
				if (this.reportPath && p === this.reportPath) return;
				if (name === "raw" && !p.endsWith(".icloud") && !this.ios.has(p)) return;
				if (++this.eventLines <= MAX_EVENT_LINES) this.log(`- ${time()} event \`${name}\`: \`${visible(p)}\``);
				else if (this.eventLines === MAX_EVENT_LINES + 1) this.log(`- (more events not logged)`);
				this.saveSoon();
			});
			this.offs.push(() => vault.offref(ref));
		}
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "link-rescue-scan-note-text",
			text: `Results are saved to "${this.reportPath ?? "a diagnostics note"}" after each step. ` +
				`${this.ios.size} file(s) in this vault are only in iCloud.`,
		});
		if (!this.probes.length) contentEl.createEl("p", { text: "No files in this note's folder are only in iCloud right now." });
		for (const probe of this.probes) {
			const s = new Setting(contentEl).setName(visible(probe.rawName)).setDesc(probe.real);
			s.addButton((b) => b.setButtonText("Read").onClick(() => this.run(`readBinary("${visible(probe.real)}")`,
				() => this.app.vault.adapter.readBinary(probe.real).then((buf) => `${buf.byteLength} bytes`), probe)));
			s.addButton((b) => b.setButtonText("verifyIcloud").onClick(() => this.verify(probe)));
			s.addButton((b) => b.setButtonText("Rescan").onClick(() => this.rescan(probe)));
		}
		const folder = this.folder();
		const row = new Setting(contentEl).setName("This folder").setDesc(folder || "(vault root)");
		if (folder) {
			row.addButton((b) => b.setButtonText("verifyIcloud (folder)").onClick(() => {
				const arg = this.fullPath(folder);
				return this.run(`verifyIcloud({path: "${arg}"})`, () => this.callVerify(arg), null);
			}));
		}
		row.addButton((b) => b.setButtonText("Open in Files").onClick(() => this.openInFiles(folder)));
		row.addButton((b) => b.setButtonText("Copy report").setCta().onClick(async () => {
			await navigator.clipboard.writeText(this.lines.join("\n"));
			new Notice("Link Rescue: diagnostics copied.");
		}));
	}

	/** Try verifyIcloud with each path form Obsidian's native plugin might expect. */
	private async verify(probe: Probe) {
		const full = this.fullPath(probe.real);
		await this.run(`verifyIcloud({path: "${visible(full)}"})`, () => this.callVerify(full), probe);
		const native = this.nativePath(probe.real);
		if (native && !this.app.vault.getAbstractFileByPath(probe.real.replace(/[  ]/g, " ").normalize("NFC"))) {
			await this.run(`verifyIcloud({path: "${visible(native)}"})`, () => this.callVerify(native), probe);
		}
	}

	private callVerify(path: string): Promise<unknown> {
		const fs = this.nativeFs;
		if (!fs || typeof fs.verifyIcloud !== "function") return Promise.reject(new Error("verifyIcloud not available"));
		return withTimeout((fs.verifyIcloud as (a: { path: string }) => Promise<unknown>).call(fs, { path }), 60000);
	}

	private async rescan(probe: Probe) {
		await this.run(`rescan "${visible(probe.real)}"`, async () => {
			await this.ios.rescanFolder(dirname(probe.real));
			const update = this.adapter.update as ((p: string) => Promise<void>) | undefined;
			if (typeof update === "function") await update.call(this.app.vault.adapter, probe.real);
			return "done";
		}, probe);
	}

	private openInFiles(folder: string) {
		const native = this.nativePath(folder);
		if (!native) {
			this.log(`- ${time()} open in Files: no native path`);
			return;
		}
		const url = native.replace(/^file:\/\//, "shareddocuments://");
		this.log(`- ${time()} open in Files: \`${url}\``);
		this.save();
		window.open(url);
	}

	/** Run one probe, log its result and timing, then report whether the file is now visible to Obsidian. */
	private async run(label: string, fn: () => Promise<unknown>, probe: Probe | null) {
		new Notice(`Link Rescue: ${label}…`);
		await this.attempt(label, fn);
		if (probe) {
			const normalized = probe.real.replace(/[  ]/g, " ").normalize("NFC");
			const placeholderLeft = await this.app.vault.adapter.exists(probe.placeholder).catch(() => false);
			const realExists = await this.app.vault.adapter.exists(probe.real).catch(() => false);
			this.log(`  - after: placeholder still there ${placeholderLeft}, real file exists ${realExists}, ` +
				`known to Obsidian ${!!this.app.vault.getAbstractFileByPath(normalized)}`);
		}
		await this.save();
		if (!this.closed) this.render();
	}

	private async attempt(label: string, fn: () => Promise<unknown>) {
		const t0 = performance.now();
		try {
			const r = await fn();
			this.log(`- ${time()} ${label}: ok in ${Math.round(performance.now() - t0)} ms → \`${short(r)}\``);
		} catch (e) {
			this.log(`- ${time()} ${label}: FAILED in ${Math.round(performance.now() - t0)} ms → \`${message(e)}\``);
		}
	}

	private fullPath(path: string): string {
		const full = this.adapter.getFullPath as ((p: string) => string) | undefined;
		return typeof full === "function" ? full.call(this.app.vault.adapter, path) : path;
	}

	private nativePath(path: string): string | null {
		const native = this.adapter.getNativePath as ((p: string) => string) | undefined;
		return typeof native === "function" ? native.call(this.app.vault.adapter, path) : null;
	}

	private log(...lines: string[]) {
		this.lines.push(...lines);
	}

	/** Pick this run's report name: per device and time, never over another file or an iCloud placeholder. */
	private async pickReportPath(): Promise<string> {
		const device = Platform.isIosApp ? (Platform.isPhone ? "iPhone" : "iPad") : Platform.isMobile ? "mobile" : "desktop";
		const stamp = new Date().toISOString().slice(0, 16).replace("T", " ").replace(":", ".");
		for (let i = 0; ; i++) {
			const name = `Link Rescue diagnostics (${device} ${stamp}${i ? ` ${i + 1}` : ""}).md`;
			const taken = this.app.vault.getAbstractFileByPath(name)
				|| await this.app.vault.adapter.exists(name).catch(() => true)
				|| await this.app.vault.adapter.exists(`.${name}.icloud`).catch(() => true);
			if (!taken) return name;
		}
	}

	/** Write the report; writes are serialized so they never pile up. */
	private save(): Promise<void> {
		this.saving = this.saving.then(async () => {
			const text = this.lines.join("\n") + "\n";
			try {
				if (!this.reportPath) this.reportPath = await this.pickReportPath();
				const existing = this.app.vault.getAbstractFileByPath(this.reportPath);
				if (existing instanceof TFile) await this.app.vault.modify(existing, text);
				else await this.app.vault.create(this.reportPath, text);
			} catch (e) {
				console.error("Link Rescue: couldn't save diagnostics", e);
				new Notice(`Link Rescue: couldn't save the diagnostics report (${message(e)}). Use "Copy report" instead.`);
			}
		});
		return this.saving;
	}
}

function join(folder: string, name: string): string {
	return folder ? `${folder}/${name}` : name;
}

/** Show invisible characters so the report makes name differences visible. */
function visible(s: string): string {
	return s.replace(/[   -‍  ⁠　﻿]/g,
		(c) => `⟨U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

function time(): string {
	return new Date().toISOString().slice(11, 19);
}

function message(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (e && typeof e === "object") return JSON.stringify(e).slice(0, 300);
	return String(e);
}

function short(v: unknown): string {
	if (v === undefined) return "undefined";
	try {
		return JSON.stringify(v).slice(0, 300);
	} catch {
		return String(v).slice(0, 300);
	}
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race([p, new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);
}
