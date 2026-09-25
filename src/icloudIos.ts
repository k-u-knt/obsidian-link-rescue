import { App, CapacitorAdapter, Platform } from "obsidian";
import { NameIndex, basename, dirname } from "./matching";

/** iCloud placeholder for a file that isn't downloaded on this device: `.<name>.icloud` next to where it belongs. */
const PLACEHOLDER = /^\.(.+)\.icloud$/;

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
	private paths = new Map<string, string>(); // real path → placeholder path
	private scanning: Promise<void> | null = null;

	constructor(private app: App) {}

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

	placeholderFor(realPath: string): string | undefined {
		return this.paths.get(realPath);
	}

	all(): Array<{ path: string; placeholder: string }> {
		return [...this.paths].map(([path, placeholder]) => ({ path, placeholder }));
	}

	/** Walk the whole vault (skipping hidden folders such as .obsidian, .trash, .git) for placeholders. */
	scan(): Promise<void> {
		if (!this.available) return Promise.resolve();
		if (this.scanning) return this.scanning;
		this.scanning = (async () => {
			const found = new Map<string, string>();
			const walk = async (folder: string) => {
				const listed = await this.list(folder);
				if (!listed) return;
				for (const file of listed.files) this.record(found, file);
				for (const sub of listed.folders) if (!basename(sub).startsWith(".")) await walk(sub);
			};
			await walk("");
			this.paths = found;
			this.rebuild();
		})().finally(() => { this.scanning = null; });
		return this.scanning;
	}

	/** Re-list one folder (e.g. after a placeholder changed or the user came back from the Files app). */
	async rescanFolder(folder: string): Promise<void> {
		if (!this.available) return;
		const listed = await this.list(folder);
		if (!listed) return;
		for (const [real] of this.paths) if (dirname(real) === folder) this.paths.delete(real);
		for (const file of listed.files) this.record(this.paths, file);
		this.rebuild();
	}

	/** The file arrived (vault "create"): it's no longer only in iCloud. */
	forget(realPath: string) {
		if (this.paths.delete(realPath)) this.rebuild();
	}

	private record(into: Map<string, string>, placeholderPath: string) {
		const m = PLACEHOLDER.exec(basename(placeholderPath));
		if (!m) return;
		const dir = dirname(placeholderPath);
		into.set(dir ? `${dir}/${m[1]}` : m[1], placeholderPath);
	}

	private rebuild() {
		this.index = new NameIndex(this.paths.keys());
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
