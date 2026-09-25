import { App, Modal, Notice, Platform, Setting, TFile, normalizePath } from "obsidian";
import { IosCloud } from "./icloudIos";
import { basename, dirname } from "./matching";

const REPORT_PATH = "Link Rescue diagnostics.md";

type AnyRecord = Record<string, unknown>;

/**
 * Device test for iCloud on iPhone/iPad. Records what the device actually shows (placeholders vs. real
 * files), which native file methods exist, and what each possible way of triggering a download does, and
 * writes it all to a note that syncs back to the other devices. Nothing here deletes or renames anything.
 */
export class DiagnosticsModal extends Modal {
	private lines: string[] = [];
	private offs: Array<() => void> = [];

	constructor(app: App, private ios: IosCloud) {
		super(app);
	}

	async onOpen() {
		this.setTitle("Link Rescue: iCloud diagnostics");
		this.log(`# Link Rescue diagnostics`, `Started ${new Date().toISOString()}`, "");
		await this.environment();
		await this.placeholders();
		this.watchEvents();
		await this.save();
		this.render();
	}

	onClose() {
		this.offs.forEach((off) => off());
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

	private async environment() {
		const fs = this.adapter.fs as AnyRecord | undefined;
		const headers = (window as unknown as { Capacitor?: { PluginHeaders?: Array<{ name: string; methods: Array<{ name: string }> }> } })
			.Capacitor?.PluginHeaders;
		this.log("## Environment",
			`- iOS app: ${Platform.isIosApp}, iPad: ${Platform.isTablet}, iPhone: ${Platform.isPhone}, mobile: ${Platform.isMobile}`,
			`- adapter: ${(this.app.vault.adapter as { constructor: { name: string } }).constructor.name}, fs.dir: ${String(fs?.dir)}`,
			`- iCloud vault detected: ${this.ios.available}`,
			`- native Filesystem methods: ${headers?.find((p) => p.name === "Filesystem")?.methods.map((m) => m.name).join(", ") ?? "(unknown)"}`,
			"");
	}

	private async placeholders() {
		const folder = this.folder();
		this.log(`## Placeholders`);
		await this.ios.scan();
		this.log(`- whole vault: ${this.ios.size} file(s) only in iCloud (\`.<name>.icloud\` placeholders)`);
		try {
			const listed = await this.app.vault.adapter.list(folder || "/");
			const inVault = new Set(this.app.vault.getFiles().filter((f) => dirname(f.path) === folder).map((f) => f.name));
			const hidden = listed.files.map(basename).filter((n) => /^\..+\.icloud$/.test(n));
			this.log(`- this folder (\`${folder || "/"}\`): ${listed.files.length} listed, ${inVault.size} known to Obsidian, ` +
				`${hidden.length} placeholder(s)`);
			for (const n of hidden.slice(0, 20)) this.log(`  - \`${n}\``);
			const notKnown = listed.files.map(basename).filter((n) => !n.startsWith(".") && !inVault.has(n));
			if (notKnown.length) this.log(`- listed but not known to Obsidian (dataless?): ${notKnown.slice(0, 20).map((n) => `\`${n}\``).join(", ")}`);
		} catch (e) {
			this.log(`- adapter.list failed: ${message(e)}`);
		}
		const first = this.ios.all().find((p) => dirname(p.path) === folder) ?? this.ios.all()[0];
		if (first) {
			this.log(`- sample: \`${first.placeholder}\` → \`${first.path}\``);
			await this.attempt("stat(placeholder)", () => this.app.vault.adapter.stat(first.placeholder));
			await this.attempt("stat(real name)", () => this.app.vault.adapter.stat(first.path));
		}
		this.log("");
	}

	private watchEvents() {
		const vault = this.app.vault as unknown as { on(name: string, cb: (...a: unknown[]) => void): unknown; offref(ref: unknown): void };
		for (const name of ["create", "raw"]) {
			const ref = vault.on(name, (arg: unknown) => {
				const p = arg instanceof TFile ? arg.path : String(arg);
				if (name === "raw" && !p.includes(".icloud") && !this.ios.has(p)) return;
				this.log(`- ${time()} event \`${name}\`: \`${p}\``);
				this.save();
			});
			this.offs.push(() => vault.offref(ref));
		}
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("p", {
			cls: "link-rescue-scan-note-text",
			text: `Results are saved to "${REPORT_PATH}" in the vault root after every step. ${this.ios.size} file(s) are only in iCloud.`,
		});
		const folder = this.folder();
		const items = this.ios.all().filter((p) => dirname(p.path) === folder);
		const list = items.length ? items : this.ios.all().slice(0, 10);
		if (!list.length) contentEl.createEl("p", { text: "No files in this vault are only in iCloud right now." });
		for (const item of list.slice(0, 15)) {
			const s = new Setting(contentEl).setName(basename(item.path)).setDesc(item.path);
			s.addButton((b) => b.setButtonText("Read").onClick(() => this.run(`read "${item.path}"`,
				() => this.app.vault.adapter.readBinary(item.path).then((buf) => `${buf.byteLength} bytes`), item.path)));
			s.addButton((b) => b.setButtonText("verifyIcloud").onClick(() => this.verify(item.path)));
			s.addButton((b) => b.setButtonText("Rescan").onClick(() => this.rescan(item.path)));
		}
		new Setting(contentEl)
			.setName("This folder")
			.setDesc(folder || "/")
			.addButton((b) => b.setButtonText("verifyIcloud (folder)").onClick(() => this.run(`verifyIcloud folder "${folder}"`,
				() => this.callVerify(this.fullPath(folder)), null)))
			.addButton((b) => b.setButtonText("Open in Files").onClick(() => this.openInFiles(folder)))
			.addButton((b) => b.setButtonText("Copy report").setCta().onClick(async () => {
				await navigator.clipboard.writeText(this.lines.join("\n"));
				new Notice("Link Rescue: diagnostics copied.");
			}));
	}

	/** Try verifyIcloud with each path form Obsidian's native plugin might expect. */
	private async verify(path: string) {
		const native = this.nativePath(path);
		await this.run(`verifyIcloud(full path) "${path}"`, () => this.callVerify(this.fullPath(path)), path);
		if (!this.app.vault.getAbstractFileByPath(path) && native) {
			await this.run(`verifyIcloud(native uri) "${path}"`, () => this.callVerify(native), path);
		}
	}

	private callVerify(path: string): Promise<unknown> {
		const fs = this.nativeFs;
		if (!fs || typeof fs.verifyIcloud !== "function") return Promise.reject(new Error("verifyIcloud not available"));
		return withTimeout((fs.verifyIcloud as (a: { path: string }) => Promise<unknown>)({ path }), 60000);
	}

	private async rescan(path: string) {
		await this.run(`rescan "${path}"`, async () => {
			await this.ios.rescanFolder(dirname(path));
			const update = this.adapter.update as ((p: string) => Promise<void>) | undefined;
			if (typeof update === "function") await update.call(this.app.vault.adapter, path);
			return "done";
		}, path);
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
	private async run(label: string, fn: () => Promise<unknown>, path: string | null) {
		new Notice(`Link Rescue: ${label}…`);
		await this.attempt(label, fn);
		if (path) {
			await this.ios.rescanFolder(dirname(path));
			const exists = await this.app.vault.adapter.exists(path).catch(() => false);
			this.log(`  - after: in vault ${!!this.app.vault.getAbstractFileByPath(path)}, exists ${exists}, ` +
				`placeholder still there ${this.ios.has(path)}`);
		}
		await this.save();
		this.render();
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

	private async save() {
		const text = this.lines.join("\n") + "\n";
		const path = normalizePath(REPORT_PATH);
		try {
			const existing = this.app.vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) await this.app.vault.modify(existing, text);
			else await this.app.vault.create(path, text);
		} catch (e) {
			console.error("Link Rescue: couldn't save diagnostics", e);
		}
	}
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
