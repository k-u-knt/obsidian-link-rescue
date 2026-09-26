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

/**
 * When a file that is only in the cloud gets downloaded. Never because a note opened or scrolled into view:
 * "hover" (shown as Automatic) when the user points at its placeholder, "manual" only when the user clicks it.
 */
export type DownloadMode = "hover" | "manual";

/** How long the pointer must rest on a placeholder before "hover" mode downloads it (skips passing sweeps). */
const HOVER_DELAY_MS = 350;
/** How far the pointer must travel from where it was seen outside a placeholder (skips hand jitter at an edge). */
const MIN_TRAVEL_PX = 4;
/** The move onto a placeholder must follow the previous pointer position within this time (continuous motion). */
const MAX_GAP_MS = 100;
/** Longest single step onto a placeholder accepted after a pause. */
const MAX_STEP_PX = 32;

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
 * Last two mouse positions per document (fractional, from pointermove), and when content last scrolled under them.
 * Positions come from the document itself rather than from `movementX/Y`, which the browser may compute from a stale
 * position (after a drag session, or after the pointer was over an embedded web page).
 */
interface PointerTrack {
	prev?: { x: number; y: number; t: number };
	last?: { x: number; y: number; t: number };
	scrolledAt: number;
	/** When the document last lost sight of the pointer (it left the view, a native menu opened, the window changed). */
	lostAt: number;
	/** When content last moved under the pointer by layout (an embed above resized itself or went away). */
	shiftedAt: number;
	/** Pick up layout shifts the browser has recorded but not yet delivered. */
	syncShifts: () => void;
	dispose: () => void;
}
const tracks = new Map<Document, PointerTrack>();

function pointerTrack(doc: Document): PointerTrack {
	const known = tracks.get(doc);
	if (known) return known;
	const onMove = (e: PointerEvent) => {
		if (e.pointerType !== "mouse") return;
		track.prev = track.last;
		track.last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
	};
	// Scrolling moves content under a still pointer: positions seen before it say nothing about what's under it now.
	const onScroll = (e: Event) => { track.scrolledAt = e.timeStamp; };
	// The pointer can travel where this document doesn't see it: another window or app, a native (macOS) context menu.
	const lose = () => { track.prev = track.last = undefined; track.lostAt = (win ?? window).performance.now(); };
	const onOut = (e: PointerEvent) => { if (!e.relatedTarget) lose(); };
	const win = doc.defaultView;
	// Content moves under a still pointer when something above it resizes itself or goes away (a tweet reporting its
	// height, an embed's line deleted): positions seen before that say nothing about what is under the pointer now.
	let shifts: PerformanceObserver | undefined;
	const noteShifts = (entries: PerformanceEntry[]) => { for (const e of entries) track.shiftedAt = Math.max(track.shiftedAt, e.startTime); };
	try {
		const PO = (win as unknown as { PerformanceObserver?: typeof PerformanceObserver } | null)?.PerformanceObserver;
		if (PO?.supportedEntryTypes?.includes("layout-shift")) {
			shifts = new PO((list) => noteShifts(list.getEntries()));
			shifts.observe({ type: "layout-shift" });
		}
	} catch { shifts = undefined; }
	// Zoom (Cmd+= / Cmd+-) and window resizes move a still pointer in page coordinates without any pointer event.
	const onResize = () => lose();
	const track: PointerTrack = {
		scrolledAt: 0,
		lostAt: 0,
		shiftedAt: 0,
		syncShifts: () => { if (shifts) noteShifts(shifts.takeRecords()); },
		dispose: () => {
			shifts?.disconnect();
			doc.removeEventListener("pointermove", onMove, true);
			doc.removeEventListener("scroll", onScroll, true);
			doc.removeEventListener("pointerout", onOut, true);
			doc.removeEventListener("contextmenu", lose, true);
			win?.removeEventListener("blur", lose);
			win?.removeEventListener("focus", lose);
			win?.removeEventListener("resize", onResize);
		},
	};
	doc.addEventListener("pointermove", onMove, true);
	doc.addEventListener("scroll", onScroll, true);
	doc.addEventListener("pointerout", onOut, true);
	doc.addEventListener("contextmenu", lose, true);
	win?.addEventListener("blur", lose);
	win?.addEventListener("focus", lose);
	win?.addEventListener("resize", onResize);
	tracks.set(doc, track);
	return track;
}

/** Remove the document listeners (plugin unload). */
export function disposePointerTracks() {
	tracks.forEach((t) => t.dispose());
	tracks.clear();
}

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
	/** When this placeholder was last inserted or re-shown; pointer positions seen before then don't count. */
	private shownAt = 0;
	/** Where the pointer was seen just outside before it came onto the placeholder. */
	private entry: { x: number; y: number } | null = null;
	/** Where the placeholder was when the pointer stopped on it. */
	private armedRect: { left: number; top: number } | null = null;

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
			// Dragging (a text selection, a card) isn't pointing at the file.
			if (evt.buttons !== 0) return;
			const track = pointerTrack(this.box.doc);
			if (!this.movedOnto) {
				// Where was the pointer just before this move? Unknown, seen before the placeholder appeared or before a
				// scroll, or already inside it: the placeholder appeared, scrolled or was dropped under the pointer and
				// this is a wobble. The pointer has to be seen outside it first.
				const prev = track.prev;
				track.syncShifts();
				if (!prev || prev.t < this.shownAt || prev.t < track.scrolledAt || prev.t <= track.shiftedAt) return;
				// A position seen a while ago says nothing about where the pointer has been since: inside an embedded
				// video, tweet or web page (this document doesn't see it there), or the window moved or zoomed under it.
				// After a pause, only a single short step that the browser also reports as this move counts (a pointer
				// parked just outside the edge).
				if (evt.timeStamp - prev.t > MAX_GAP_MS) {
					const dx = evt.clientX - prev.x, dy = evt.clientY - prev.y;
					if (Math.hypot(dx, dy) > MAX_STEP_PX || Math.abs(dx - evt.movementX) > 2 || Math.abs(dy - evt.movementY) > 2) return;
				}
				const r = this.box.getBoundingClientRect();
				if (prev.x >= r.left && prev.x <= r.right && prev.y >= r.top && prev.y <= r.bottom) return;
				this.movedOnto = true;
				this.entry = { x: prev.x, y: prev.y };
			}
			// A jitter of a pixel or two across the edge doesn't count: the pointer has to travel onto the placeholder.
			if (!this.entry || Math.hypot(evt.clientX - this.entry.x, evt.clientY - this.entry.y) < MIN_TRAVEL_PX) return;
			this.cancelHover();
			const at = this.box.getBoundingClientRect();
			this.armedRect = { left: at.left, top: at.top };
			const armedAt = evt.timeStamp;
			this.hoverTimer = window.setTimeout(() => {
				this.hoverTimer = null;
				if (this.host.downloadMode !== "hover" || this.state !== "idle" || !this.box.isShown()) return;
				// Still resting on it? `:hover` isn't updated while content scrolls on the compositor (trackpad) or moves by
				// layout or transform (canvas pan), so check that the placeholder hasn't moved and is still what the pointer is on.
				const last = track.last;
				const r = this.box.getBoundingClientRect();
				const was = this.armedRect;
				if (!last || !was || track.lostAt > armedAt) return;
				if (Math.abs(r.left - was.left) > 1 || Math.abs(r.top - was.top) > 1) return;
				// What is under the pointer now (not a modal or menu that opened over it, not other content)?
				if (!this.box.contains(this.box.doc.elementFromPoint(last.x, last.y))) return;
				// Last seen heading into an embedded web page/video? This document doesn't see the pointer there.
				const before = track.prev;
				if (before) {
					const dx = last.x - before.x, dy = last.y - before.y;
					for (let k = 1; k <= 3; k++) {
						const ahead = this.box.doc.elementFromPoint(last.x + dx * k, last.y + dy * k);
						if (ahead?.closest("iframe, webview, embed, object")) return;
					}
				}
				void this.start();
			}, HOVER_DELAY_MS);
		});
		this.box.addEventListener("mouseleave", () => {
			this.movedOnto = false;
			this.entry = null;
			this.cancelHover();
		});
		pointerTrack(this.box.doc);
		// Inserted, re-attached (reading view virtualization) or re-shown (tab switch): start over.
		this.box.onNodeInserted(() => {
			// Popout windows have their own document and clock: track that document, time on that window's clock.
			pointerTrack(this.box.doc);
			this.shownAt = this.box.win.performance.now();
			this.movedOnto = false;
			this.entry = null;
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
		// A move onto the placeholder seen under the previous mode doesn't count under the new one.
		this.movedOnto = false;
		this.entry = null;
		this.cancelHover();
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
		if (this.containerEl.closest("body > .print")) return this.start();
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
export function gateHtmlMedia(host: CloudHost, el: HTMLElement, file: TFile, src: string, resourcePath: () => string): Promise<void> {
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
	// The element is often still detached while post-processors run; once inserted, an Export to PDF needs the file.
	holder.onNodeInserted(() => { if (holder.closest("body > .print")) void placeholder.start(); }, true);
	return placeholder.begin();
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
