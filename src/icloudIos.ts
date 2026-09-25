import { App, CapacitorAdapter, Platform } from "obsidian";
import { NameIndex, basename, dirname } from "./matching";

/** iCloud placeholder for a file that isn't downloaded on this device: `.<name>.icloud` next to where it belongs. */
const PLACEHOLDER = /^\.(.+)\.icloud$/;

/** Like Obsidian: any path segment starting with "." is hidden (.obsidian, .trash, .git, placeholders). */
export function isHiddenPath(path: string): boolean {
	return path.split("/").some((seg) => seg.startsWith("."));
}

/**
 * iOS/iPadOS: files that iCloud hasn't downloaded to the device exist only as hidden `.<name>.icloud`
 * placeholders. Obsidian skips every path segment that starts with ".", so such a file has no TFile at all:
 * embeds say "could not be found", and following a link would create an empty file with the same name.
 * This keeps an index of those placeholders (via the public adapter.list(), which doesn't filter dot-files),
 * so the plugin can tell "not downloaded on this device" apart from "missing".
 */
export class IosCloud {
	/** Real (Obsidian-normalized) paths of files that are only in iCloud, looked up like links. */
	index = new NameIndex();
	/** Resolves when the first full scan has finished (successfully or not). */
	readonly ready: Promise<void>;
	scanned = false;
	/** Folders that couldn't be listed in the last scan. */
	failures = 0;

	private paths = new Map<string, string>(); // real path → placeholder path
	private scanning: Promise<string[]> | null = null;
	// Changes that arrive while a scan is walking, re-applied once it finishes.
	private forgottenDuringScan = new Set<string>();
	private foldersDuringScan = new Set<string>();
	private markReady!: () => void;

	constructor(private app: App) {
		this.ready = new Promise((resolve) => { this.markReady = resolve; });
		if (!this.available) {
			this.scanned = true;
			this.markReady();
		}
	}

	/** True in Obsidian for iPhone/iPad on a vault stored in iCloud Drive (the same check Obsidian itself uses). */
	get available(): boolean {
		if (!Platform.isIosApp || typeof CapacitorAdapter !== "function") return false;
		const adapter = this.app.vault.adapter as unknown as { fs?: { dir?: string } };
		return this.app.vault.adapter instanceof CapacitorAdapter && adapter.fs?.dir === "ICLOUD";
	}

	get size(): number {
		return this.paths.size;
	}

	has(realPath: string): boolean {
		return this.paths.has(realPath);
	}

	all(): Array<{ path: string; placeholder: string }> {
		return [...this.paths].map(([path, placeholder]) => ({ path, placeholder }));
	}

	/**
	 * Walk the whole vault (skipping hidden folders such as .obsidian, .trash, .git) for placeholders.
	 * Resolves with the real paths whose placeholder disappeared since the previous scan.
	 */
	scan(): Promise<string[]> {
		if (!this.available) return Promise.resolve([]);
		if (this.scanning) return this.scanning;
		this.forgottenDuringScan.clear();
		this.foldersDuringScan.clear();
		const previous = new Set(this.paths.keys());
		const p: Promise<string[]> = (async () => {
			const found = new Map<string, string>();
			let failures = 0;
			const walk = async (folder: string) => {
				const listed = await this.list(folder);
				if (!listed) {
					failures++;
					// Keep what we knew about this subtree rather than dropping it.
					for (const [real, ph] of this.paths) if (real.startsWith(folder ? `${folder}/` : "")) found.set(real, ph);
					return;
				}
				for (const file of listed.files) record(found, file);
				for (const sub of listed.folders) if (!isHiddenPath(sub)) await walk(sub);
			};
			await walk("");
			this.paths = found;
			this.failures = failures;
			for (const real of this.forgottenDuringScan) this.paths.delete(real);
			this.index = new NameIndex(this.paths.keys());
			// Folders that changed while we walked: list them again (until nothing new came in).
			while (this.foldersDuringScan.size) {
				const folders = [...this.foldersDuringScan];
				this.foldersDuringScan.clear();
				for (const f of folders) await this.relist(f);
			}
			return [...previous].filter((real) => !this.paths.has(real));
		})().finally(() => {
			if (this.scanning === p) this.scanning = null;
			if (!this.scanned) {
				this.scanned = true;
				this.markReady();
			}
		});
		this.scanning = p;
		return p;
	}

	/** Re-list one folder (e.g. after a placeholder changed). Returns real paths whose placeholder disappeared. */
	async rescanFolder(folder: string): Promise<string[]> {
		if (!this.available || isHiddenPath(folder)) return [];
		if (this.scanning) this.foldersDuringScan.add(folder);
		return this.relist(folder);
	}

	private async relist(folder: string): Promise<string[]> {
		const listed = await this.list(folder);
		if (!listed) return [];
		const before = new Set([...this.paths.keys()].filter((p) => dirname(p) === folder));
		for (const p of before) this.paths.delete(p);
		for (const file of listed.files) record(this.paths, file);
		this.index = new NameIndex(this.paths.keys());
		return [...before].filter((p) => !this.paths.has(p));
	}

	/** Does the folder contain a placeholder for this name? (One cheap check, no full scan.) */
	async hasPlaceholder(folder: string, name: string): Promise<boolean> {
		if (!this.available) return false;
		const ph = `.${name}.icloud`;
		try {
			return await this.app.vault.adapter.exists(folder ? `${folder}/${ph}` : ph);
		} catch {
			return false;
		}
	}

	/** The file arrived (vault "create"): it's no longer only in iCloud. Returns whether it was indexed. */
	forget(realPath: string): boolean {
		if (this.scanning) this.forgottenDuringScan.add(realPath);
		if (!this.paths.delete(realPath)) return false;
		this.index.remove(realPath);
		return true;
	}

	private async list(folder: string) {
		const adapter = this.app.vault.adapter;
		for (const path of folder ? [folder] : ["", "/"]) {
			try {
				return await adapter.list(path);
			} catch {
				// try the next form of the root path
			}
		}
		return null;
	}
}

function record(into: Map<string, string>, placeholderPath: string) {
	const m = PLACEHOLDER.exec(basename(placeholderPath));
	if (!m) return;
	const dir = dirname(placeholderPath);
	if (isHiddenPath(dir)) return;
	into.set(dir ? `${dir}/${m[1]}` : m[1], placeholderPath);
}
