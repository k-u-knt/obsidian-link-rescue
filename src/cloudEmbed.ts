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

/** When a file that is only in the cloud gets downloaded. */
export type DownloadMode = "auto" | "hover" | "manual";

/** How long the pointer must rest on a placeholder before "hover" mode downloads it (skips passing sweeps). */
const HOVER_DELAY_MS = 350;

export interface CloudHost {
	readonly downloadMode: DownloadMode;
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
	private hoverTimer: number | null = null;
	/** The pointer came onto the placeholder from outside it (not: the placeholder appeared under it). */
	private movedOnto = false;

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
		// "On hover": download only when the user moves the pointer onto this file and rests it there. Only real
		// movement counts: the browser also reports "pointer entered" when a note opens or scrolls under a pointer
		// that isn't moving, and opening a note must never download anything.
		this.box.addEventListener("mousemove", (evt: MouseEvent) => {
			if (this.host.downloadMode !== "hover" || this.state !== "idle") return;
			if (evt.movementX === 0 && evt.movementY === 0) return;
			if (!this.movedOnto) {
				// Where was the pointer before this move? If already inside, the placeholder appeared (or scrolled)
				// under a resting pointer and this is just a wobble: it has to leave and come back to count.
				const r = this.box.getBoundingClientRect();
				const x = evt.clientX - evt.movementX;
				const y = evt.clientY - evt.movementY;
				if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return;
				this.movedOnto = true;
			}
			this.cancelHover();
			this.hoverTimer = window.setTimeout(() => {
				this.hoverTimer = null;
				if (this.host.downloadMode === "hover" && this.state === "idle" && this.box.matches(":hover")) void this.start();
			}, HOVER_DELAY_MS);
		});
		this.box.addEventListener("mouseleave", () => {
			this.movedOnto = false;
			this.cancelHover();
		});
		this.render();
	}

	private cancelHover() {
		if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
		this.hoverTimer = null;
	}

	/** Re-draw after the download mode changed (the hint text depends on it). */
	refresh() {
		if (this.state === "idle" || this.state === "failed") this.render();
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
		if (this.host.downloadMode === "auto") return Promise.race([this.start(), sleep(5000)]);
		return Promise.resolve();
	}

	/** Download the file, then show it. Resolves once Obsidian's embed has loaded it. */
	start(): Promise<void> {
		this.cancelHover();
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
		this.cancelHover();
		this.state = "retired";
		this.host.untrack(this);
		if (message && this.box.isConnected) {
			this.box.empty();
			this.box.addClass("is-retired");
			this.box.createDiv({ cls: "link-rescue-cloud-status", text: message });
		}
	}

	private hint(): string {
		// Canvas covers cards that aren't selected, so the pointer only reaches the placeholder after selecting.
		const card = this.containerEl.closest(".canvas-node") ? "Select the card, then " : "";
		const action = this.host.downloadMode === "hover" ? "point at it to download." : "click to download.";
		return card ? card + action : action.charAt(0).toUpperCase() + action.slice(1);
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
					: `In ${where}, not downloaded (${size}). ${this.hint()}`,
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
		const placeholder = new CloudPlaceholder(host, el, file, async () => {
			if (!img) return load();
			await setSrc(img, resourcePath());
			// Live Preview hid its zoom/edit buttons while the image had no size; re-check once it's laid out.
			if (el.hasClass("no-hover-actions")) {
				const observer = new ResizeObserver(() => {
					if (!img.isConnected || img.offsetWidth === 0) return;
					el.toggleClass("no-hover-actions", img.offsetWidth < 80);
					observer.disconnect();
				});
				observer.observe(img);
				real.register(() => observer.disconnect());
			}
		});
		real.register(() => placeholder.retire());
		return placeholder.begin();
	};
}

/**
 * Gate an HTML media element (e.g. `<img src="attachments/x.png">` in a note, a Live Preview HTML block, a Bases
 * text value) whose file is only in the cloud: Obsidian would point it at the file right away, which downloads it.
 * The element is hidden and its `src` held back until the placeholder downloads the file.
 */
export function gateHtmlMedia(host: CloudHost, el: HTMLElement, file: TFile, src: string, resourcePath: () => string) {
	const media = el.tagName === "SOURCE" ? (el.parentElement ?? el) : el;
	// An empty src (rather than none) makes a pending <img> fire "error", so Obsidian's own image post-processor,
	// which waits for load/error, finishes and the reading view completes its render.
	if (el.tagName === "IMG") el.setAttribute("src", "");
	else el.removeAttribute("src");
	el.setAttr("data-link-rescue-src", src);
	media.addClass("link-rescue-hidden");
	const holder = createSpan({ cls: "link-rescue-html-holder" });
	media.insertAdjacentElement("beforebegin", holder);
	const placeholder = new CloudPlaceholder(host, holder, file, async () => {
		holder.remove();
		media.removeClass("link-rescue-hidden");
		el.removeAttribute("data-link-rescue-src");
		if (el.tagName === "IMG") await setSrc(el as HTMLImageElement, resourcePath());
		else {
			el.setAttr("src", resourcePath());
			if (media instanceof HTMLMediaElement) media.load();
		}
	});
	void placeholder.begin();
	// The element is still detached while post-processors run; once inserted, an Export to PDF (.print) needs the file.
	holder.onNodeInserted(() => { if (holder.closest(".print")) void placeholder.start(); }, true);
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
