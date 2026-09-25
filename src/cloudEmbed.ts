import { Component, TFile, setIcon } from "obsidian";

/** What Obsidian's embed creators receive (internal: `app.embedRegistry`). */
export interface EmbedContext {
	containerEl: HTMLElement;
	[key: string]: unknown;
}

export interface EmbedComponent extends Component {
	loadFile(): Promise<void> | void;
}

export type EmbedCreator = (ctx: EmbedContext, file: TFile, subpath?: string) => EmbedComponent | null;

export interface CloudHost {
	readonly autoDownload: boolean;
	/** "iCloud", or "the cloud" for other File Provider services. */
	readonly cloudName: string;
	/** Download the file; once done, the host calls finish() on every placeholder of that file. */
	download(file: TFile): Promise<void>;
	track(p: CloudPlaceholder): void;
	untrack(p: CloudPlaceholder): void;
}

type State = "idle" | "downloading" | "failed" | "done" | "retired";

/**
 * Shown in an embed's container while its file is only in the cloud. Downloads the file right away
 * (automatic mode), when clicked (manual mode), or always when the note is being exported, and then
 * calls `reveal` to let Obsidian's own embed display the file.
 */
export class CloudPlaceholder {
	private state: State = "idle";
	private box: HTMLElement;
	private started?: Promise<void>;
	private revealing?: Promise<void>;

	constructor(
		private host: CloudHost,
		readonly containerEl: HTMLElement,
		readonly file: TFile,
		private reveal: () => Promise<void>,
	) {
		containerEl.addClass("link-rescue-cloud-pending");
		this.box = containerEl.createDiv({ cls: "link-rescue-cloud-embed" });
		// Keep clicks away from Obsidian's own handlers (e.g. Live Preview selecting the embed's source).
		const swallow = (evt: MouseEvent) => {
			evt.preventDefault();
			evt.stopPropagation();
			if (evt.type === "click" && (this.state === "idle" || this.state === "failed")) this.start();
		};
		this.box.addEventListener("click", swallow);
		this.box.addEventListener("mousedown", swallow);
		this.render();
	}

	get pending(): boolean {
		return this.state === "idle" || this.state === "downloading" || this.state === "failed";
	}

	get downloading(): boolean {
		return this.state === "downloading";
	}

	/** What the embed's loadFile() should return. Never blocks rendering for more than a few seconds. */
	begin(): Promise<void> {
		this.host.track(this);
		// Export to PDF waits for loadFile(); download so the export shows the file, not the placeholder.
		if (this.containerEl.closest(".print")) return this.start();
		if (this.host.autoDownload) return Promise.race([this.start(), sleep(5000)]);
		return Promise.resolve();
	}

	/** Download the file, then show it. Resolves once Obsidian's embed has loaded it. */
	start(): Promise<void> {
		if (this.state === "retired") return Promise.resolve();
		if (this.state === "done") return this.revealing ?? Promise.resolve();
		if (this.state === "downloading" && this.started) return this.started;
		this.state = "downloading";
		this.render();
		this.started = this.host.download(this.file).then(
			() => this.finish(),
			(e) => {
				if (this.state !== "downloading") return;
				console.error(`Link Rescue: ${this.host.cloudName} download failed`, this.file.path, e);
				this.state = "failed";
				this.started = undefined;
				this.render();
			},
		);
		return this.started;
	}

	/** The file is local now: remove the placeholder and let Obsidian's embed show it. Idempotent. */
	finish(): Promise<void> {
		if (this.state === "retired") return Promise.resolve();
		if (this.revealing) return this.revealing;
		this.state = "done";
		this.host.untrack(this);
		this.box.remove();
		this.containerEl.removeClass("link-rescue-cloud-pending");
		this.revealing = this.reveal().catch((e) => console.error("Link Rescue: couldn't show", this.file.path, e));
		return this.revealing;
	}

	/** Stop for good: the embed was unloaded, or the plugin is being disabled (then show `message`). */
	retire(message?: string) {
		if (this.state === "done" || this.state === "retired") return;
		this.state = "retired";
		this.host.untrack(this);
		if (message && this.box.isConnected) {
			this.box.empty();
			this.box.addClass("is-retired");
			this.box.createDiv({ cls: "link-rescue-cloud-status", text: message });
		}
	}

	private render() {
		const box = this.box;
		const where = this.host.cloudName;
		box.empty();
		box.toggleClass("is-downloading", this.state === "downloading");
		box.toggleClass("is-failed", this.state === "failed");
		const icon = box.createSpan({ cls: "link-rescue-cloud-icon" });
		setIcon(icon, this.state === "downloading" ? "loader" : this.state === "failed" ? "alert-triangle" : "cloud-download");
		const text = box.createDiv({ cls: "link-rescue-cloud-text" });
		text.createDiv({ cls: "link-rescue-cloud-name", text: this.file.name });
		const size = formatSize(this.file.stat.size);
		text.createDiv({
			cls: "link-rescue-cloud-status",
			text: this.state === "downloading"
				? `Downloading from ${where} (${size})…`
				: this.state === "failed"
					? `Download from ${where} failed. Click to try again.`
					: `In ${where}, not downloaded (${size}). Click to download.`,
		});
	}
}

/**
 * Gate an image/audio/video embed that Obsidian created: keep Obsidian's own component (Live Preview and
 * canvas decide how to treat an embed from its class) and only defer its loadFile until the file is local.
 */
export function gateMediaEmbed(host: CloudHost, ctx: EmbedContext, file: TFile, real: EmbedComponent,
	isImage: boolean, isStillInCloud: () => boolean, resourcePath: () => string): void {
	const load = real.loadFile.bind(real);
	real.loadFile = () => {
		if (!isStillInCloud()) return load();
		const el = ctx.containerEl;
		// For images, create the <img> now, as Obsidian would but without a src: Live Preview looks it up right
		// after loadFile() to attach its resize handle and context menu. It gets its src once downloaded.
		const img = isImage ? createImg(el) : null;
		const placeholder = new CloudPlaceholder(host, el, file,
			async () => { if (img) await setSrc(img, resourcePath()); else await load(); });
		real.register(() => placeholder.retire());
		return placeholder.begin();
	};
}

/** Stand-in used for PDFs, whose viewer builds itself inside the container: swapped for the real embed later. */
export class CloudEmbed extends Component implements EmbedComponent {
	private placeholder: CloudPlaceholder | null = null;
	private dead = false;

	constructor(
		private host: CloudHost,
		private ctx: EmbedContext,
		readonly file: TFile,
		private createReal: () => EmbedComponent | null,
	) {
		super();
	}

	loadFile(): Promise<void> {
		const el = this.ctx.containerEl;
		this.placeholder = new CloudPlaceholder(this.host, el, this.file, async () => {
			if (this.dead) return;
			el.empty();
			const real = this.createReal();
			if (!real) return;
			this.addChild(real);
			await real.loadFile();
		});
		return this.placeholder.begin();
	}

	onunload() {
		this.dead = true;
		this.placeholder?.retire();
	}
}

/** Same element Obsidian's image loader creates (alt, width and height copied from the container). */
function createImg(el: HTMLElement): HTMLImageElement {
	const img = el.createEl("img");
	const alt = el.getAttr("alt");
	if (alt) img.setAttr("alt", alt);
	const width = el.getAttr("width");
	const height = el.getAttr("height");
	if (width) img.setAttr("width", width);
	if (height) img.setAttr("height", height);
	return img;
}

/** Set an image's src and wait for it to load (or fail), at most 5 s, like Obsidian does. */
function setSrc(img: HTMLImageElement, src: string): Promise<void> {
	return new Promise((resolve) => {
		const done = () => resolve();
		img.addEventListener("load", done, { once: true });
		img.addEventListener("error", done, { once: true });
		window.setTimeout(done, 5000);
		img.src = src;
	});
}

export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
