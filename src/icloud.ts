import { App, FileSystemAdapter, Platform } from "obsidian";

// macOS stat flag for files whose contents live only in the cloud (MacOSX.sdk sys/stat.h: SF_DATALESS).
const SF_DATALESS = 0x40000000;
// Reads of dataless files block a Node threadpool thread until iCloud delivers the data, so keep few in flight.
const MAX_CONCURRENT_DOWNLOADS = 2;

/**
 * iCloud Drive helpers for macOS. Since macOS 14, iCloud keeps evicted files in place under their real
 * names but marks them "dataless"; reading any byte makes the File Provider download the whole file.
 * (`brctl download` no longer exists.) Everything here is a no-op on other platforms.
 */
export class ICloud {
	private inFlight = new Map<string, Promise<void>>();
	private queue: Array<() => void> = [];
	private running = 0;

	constructor(private app: App) {}

	get available(): boolean {
		return Platform.isDesktopApp && !Platform.isMobile && Platform.isMacOS && this.app.vault.adapter instanceof FileSystemAdapter;
	}

	/** "iCloud" for vaults in iCloud Drive; other File Provider services (Dropbox, OneDrive…) use the same flag. */
	get cloudName(): string {
		if (!this.available) return "iCloud";
		const base = (this.app.vault.adapter as FileSystemAdapter).getBasePath();
		return base.includes("/Library/Mobile Documents/") ? "iCloud" : "the cloud";
	}

	/** Absolute on-disk path. The adapter maps Obsidian's normalized path back to the real name (e.g. with U+202F). */
	private fullPath(vaultPath: string): string {
		return (this.app.vault.adapter as FileSystemAdapter).getFullPath(vaultPath);
	}

	/** Whether the file is only in iCloud and not downloaded yet. */
	async isDataless(vaultPath: string): Promise<boolean> {
		if (!this.available) return false;
		const { execFile } = require("child_process") as typeof import("child_process");
		return new Promise((resolve) => {
			// `stat -f %Xf` prints st_flags in hex. Node's fs.stat doesn't expose st_flags.
			execFile("/usr/bin/stat", ["-f", "%Xf", this.fullPath(vaultPath)], (err, stdout) => {
				if (err) return resolve(false);
				resolve((parseInt(stdout.trim(), 16) & SF_DATALESS) !== 0);
			});
		});
	}

	/**
	 * Synchronous version for Obsidian's (synchronous) embed creators. A dataless file has a size but no
	 * allocated blocks; only files that look like that pay for the exact flag check.
	 */
	isDatalessSync(vaultPath: string): boolean {
		if (!this.available) return false;
		const fs = require("fs") as typeof import("fs");
		const full = this.fullPath(vaultPath);
		try {
			const st = fs.statSync(full);
			if (st.size === 0 || st.blocks !== 0) return false;
			const { execFileSync } = require("child_process") as typeof import("child_process");
			const flags = parseInt(execFileSync("/usr/bin/stat", ["-f", "%Xf", full], { encoding: "utf8", timeout: 2000 }).trim(), 16);
			return (flags & SF_DATALESS) !== 0;
		} catch {
			return false;
		}
	}

	/** Ask iCloud to download the file by reading its first byte; resolves once the read returns. */
	download(vaultPath: string): Promise<void> {
		if (!this.available) return Promise.reject(new Error("iCloud downloads are only supported on macOS"));
		const existing = this.inFlight.get(vaultPath);
		if (existing) return existing;
		const p = this.schedule(async () => {
			const fs = require("fs") as typeof import("fs");
			const handle = await fs.promises.open(this.fullPath(vaultPath), "r");
			try {
				await handle.read(Buffer.alloc(1), 0, 1, 0);
			} finally {
				await handle.close();
			}
		}).finally(() => this.inFlight.delete(vaultPath));
		this.inFlight.set(vaultPath, p);
		return p;
	}

	private schedule(task: () => Promise<void>): Promise<void> {
		return new Promise((resolve, reject) => {
			const run = () => {
				this.running++;
				task().then(resolve, reject).finally(() => {
					this.running--;
					this.queue.shift()?.();
				});
			};
			if (this.running < MAX_CONCURRENT_DOWNLOADS) run();
			else this.queue.push(run);
		});
	}
}
