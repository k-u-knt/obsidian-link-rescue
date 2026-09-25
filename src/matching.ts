// Pure matching logic, no Obsidian imports, so it can be unit-tested with plain Node.
//
// Why links break (verified against Obsidian 1.13.7): the vault adapters build every file path with
// normalizePath, which replaces U+00A0 and U+202F with a plain space and applies NFC. So a file saved on
// disk as "Screenshot … 2.22.58<U+202F>PM.png" (as macOS names screenshots) is known to Obsidian as
// "Screenshot … 2.22.58 PM.png". Link text, however, only has U+00A0 replaced. A link that contains
// U+202F (e.g. a file name copied from Finder) therefore never resolves. The fix is to rewrite the link
// text to the name Obsidian indexes the file under; renaming the file does nothing.

// Characters that render as (or like) a normal space but are different code points.
const SPACE_LIKE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
// Characters that render as nothing at all.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;

/** Comparison key: names that differ only by lookalike spaces, invisible characters, NFC/NFD or case collide. */
export function normalizeKey(s: string): string {
	return s.normalize("NFC").replace(SPACE_LIKE, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** What Obsidian itself does to link text before resolving it (U+00A0 only, trim, NFC). */
export function obsidianLinktext(s: string): string {
	return s.replace(/\u00A0/g, " ").trim().normalize("NFC");
}

export function basename(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
	const i = path.lastIndexOf("/");
	return i === -1 ? "" : path.slice(0, i);
}

/** Split a link like `Note#Heading` into its path and subpath (`#Heading`). */
export function splitSubpath(link: string): { path: string; subpath: string } {
	const i = link.indexOf("#");
	return i === -1 ? { path: link, subpath: "" } : { path: link.slice(0, i), subpath: link.slice(i) };
}

/**
 * Index of vault file paths, looked up the way Obsidian's resolver does (by file name, then by
 * `name + ".md"`, then filtered by path suffix for links with folders), except that lookalike
 * characters, NFC/NFD and case are ignored.
 */
export class NameIndex {
	/** normalized full file name (with extension) → paths */
	private byName = new Map<string, string[]>();

	constructor(paths: Iterable<string> = []) {
		for (const p of paths) this.add(p);
	}

	add(path: string): void {
		const key = normalizeKey(basename(path));
		const list = this.byName.get(key);
		if (!list) this.byName.set(key, [path]);
		else if (!list.includes(path)) list.push(path);
	}

	remove(path: string): void {
		const key = normalizeKey(basename(path));
		const list = this.byName.get(key);
		if (!list) return;
		const rest = list.filter((p) => p !== path);
		if (rest.length) this.byName.set(key, rest);
		else this.byName.delete(key);
	}

	/**
	 * Files a link (without `#subpath`) would resolve to if lookalike characters were ignored. Like Obsidian,
	 * `./` and `../` are relative to the linking note and a leading `/` means the vault root; both must match
	 * the whole path.
	 */
	find(linkpath: string, sourcePath = ""): string[] {
		let exact = absoluteLinkpath(linkpath, sourcePath);
		if (exact !== null) {
			// Obsidian strips exactly one leading "/" (absoluteLinkpath already did for "/…" links); if another
			// remains, nothing matches.
			if (!linkpath.startsWith("/")) exact = exact.replace(/^\//, "");
			if (exact.startsWith("/")) return [];
		}
		const link = normalizeKey(exact ?? linkpath);
		if (!link) return [];
		const name = basename(link);
		// Like Obsidian: an exact file name (with extension) first, then the name + ".md".
		let fullLink = link;
		let hits = name.includes(".") ? this.byName.get(name) : undefined;
		if (!hits?.length) {
			fullLink = `${link}.md`;
			hits = this.byName.get(`${name}.md`);
		}
		if (!hits?.length) return [];
		if (exact !== null) {
			const exactHits = hits.filter((p) => normalizeKey(p) === fullLink);
			// Vault-absolute links must match exactly; relative ones fall back to a suffix match, like Obsidian.
			if (exactHits.length || linkpath.startsWith("/")) return exactHits;
		}
		if (!link.includes("/")) return [...hits];
		// Links with folders must match the end of the file's path at a folder boundary.
		return hits.filter((p) => {
			const path = normalizeKey(p);
			return path === fullLink || path.endsWith(`/${fullLink}`);
		});
	}
}

/** Vault path for relative (`./`, `../`) or vault-absolute (`/…`) links; null for ordinary links. */
export function absoluteLinkpath(linkpath: string, sourcePath: string): string | null {
	if (linkpath.startsWith("/")) return linkpath.slice(1);
	if (!linkpath.startsWith("./") && !linkpath.startsWith("../")) return null;
	let rel = linkpath.replace(/^\.\/(?=\.\.\/)/, "");
	let folder = dirname(sourcePath);
	if (rel.startsWith("./")) rel = rel.slice(2);
	while (rel.startsWith("../")) {
		rel = rel.slice(3);
		folder = dirname(folder);
	}
	return folder ? `${folder}/${rel}` : rel;
}

/**
 * Pick the one candidate a link should point to, or null when it is ambiguous.
 * Ties are broken in favour of the file in the same folder as the note containing the link.
 */
export function pickCandidate(candidates: string[], sourcePath: string): string | null {
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) return null;
	const sameFolder = candidates.filter((c) => dirname(c) === dirname(sourcePath));
	return sameFolder.length === 1 ? sameFolder[0] : null;
}

/**
 * The link path to write so the link resolves to `targetPath`: the original link with its
 * lookalike-character differences removed. Keeps its form: `./`/`../` segments, a leading `/`, how many
 * folders it names, and whether it spells out the extension.
 */
export function rewriteLinkpath(linkpath: string, targetPath: string): string {
	const segments = linkpath.split("/");
	// Leading "", ".", ".." segments stay; the named segments are replaced by the target's last ones.
	let keep = 0;
	while (keep < segments.length - 1 && (segments[keep] === "" || segments[keep] === "." || segments[keep] === "..")) keep++;
	const named = segments.length - keep;
	let replacement = targetPath.split("/").slice(-named).join("/");
	// Obsidian lets note links leave out ".md"; attachments always name their extension.
	const linkName = normalizeKey(basename(linkpath));
	const targetExt = extension(targetPath);
	if (targetExt === "md" && !linkName.endsWith(".md")) replacement = replacement.slice(0, -3);
	return [...segments.slice(0, keep), replacement].join("/");
}

function extension(path: string): string {
	const name = basename(path);
	const i = name.lastIndexOf(".");
	return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export interface LinkEdit {
	/** Offsets of the whole link (e.g. `![[a b.png|200]]`) in the note. */
	start: number;
	end: number;
	/** The whole link as it appears in the note; used to check the note hasn't changed. */
	original: string;
	/** Link path as Obsidian parsed it (no subpath). */
	oldLinkpath: string;
	newLinkpath: string;
}

/**
 * Apply link edits to a note. Edits whose text no longer matches (the note changed since it was
 * indexed) or whose link target can't be located inside the link are skipped.
 */
export function applyEdits(text: string, edits: LinkEdit[]): { text: string; applied: number } {
	let applied = 0;
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	for (const e of sorted) {
		if (text.slice(e.start, e.end) !== e.original) continue;
		const replaced = replaceLinkTarget(e.original, e.oldLinkpath, e.newLinkpath);
		if (replaced === null || replaced === e.original) continue;
		text = text.slice(0, e.start) + replaced + text.slice(e.end);
		applied++;
	}
	return { text, applied };
}

/**
 * Replace the target path of a single wikilink (`[[path#sub|alias]]`, `![[…]]`) or markdown link
 * (`[text](path#sub "title")`, `![alt](<path with spaces>)`). Only the path part is touched, and only
 * when it matches `oldPath` up to lookalike characters. Returns null when it doesn't.
 */
export function replaceLinkTarget(original: string, oldPath: string, newPath: string): string | null {
	const wiki = /^(!?\[\[)([^\]|]*)/.exec(original);
	if (wiki) {
		// Like Obsidian's parser: the target is the text before "|" (or "]]"), minus one trailing backslash
		// (tables escape the alias separator as "\|"), and the path is the part before "#".
		const start = wiki[1].length;
		const region = wiki[2];
		let pathEnd = region.indexOf("#");
		if (pathEnd === -1) {
			const trimmed = region.replace(/\s+$/, "");
			pathEnd = trimmed.endsWith("\\") ? trimmed.length - 1 : region.length;
		}
		const raw = region.slice(0, pathEnd);
		if (normalizeKey(raw) !== normalizeKey(oldPath)) return null;
		const lead = raw.match(/^\s*/)![0];
		const trail = raw.match(/\s*$/)![0];
		return original.slice(0, start) + lead + newPath + trail + original.slice(start + raw.length);
	}
	// Markdown link: the destination follows the last "](" (link text may itself contain brackets).
	const open = original.lastIndexOf("](");
	if (open === -1 || !original.endsWith(")")) return null;
	const destStart = open + 2;
	const angle = original[destStart] === "<";
	const bodyStart = destStart + (angle ? 1 : 0);
	const rest = original.slice(bodyStart, -1);
	// The destination ends at ">" inside <…>, otherwise at the first whitespace (a title may follow).
	const destEnd = angle ? rest.indexOf(">") : rest.search(/\s|$/);
	if (destEnd === -1) return null;
	const dest = rest.slice(0, destEnd);
	const hash = dest.indexOf("#");
	const rawPath = hash === -1 ? dest : dest.slice(0, hash);
	const pathEnd = bodyStart + rawPath.length;
	let decoded = rawPath;
	try {
		decoded = decodeURI(rawPath);
	} catch {
		// keep raw
	}
	if (normalizeKey(decoded) !== normalizeKey(oldPath)) return null;
	// Inside <…> spaces are allowed as-is; otherwise encode "%" and spaces so the link decodes back to newPath.
	const encoded = angle ? newPath : newPath.replace(/%/g, "%25").replace(/ /g, "%20");
	return original.slice(0, bodyStart) + encoded + original.slice(pathEnd);
}

const ATTACHMENT_EXTENSIONS =
	/\.(png|jpe?g|gif|bmp|svg|webp|avif|heic|tiff?|pdf|mp3|wav|m4a|ogg|flac|3gp|mp4|mov|webm|mkv|ogv|canvas|base)$/i;

/**
 * An empty note like `figure.png.md`: what Obsidian's "Click to create" makes when an embed of
 * `figure.png` doesn't resolve.
 */
export function isClickToCreateStub(path: string, size: number): boolean {
	if (size !== 0 || !path.toLowerCase().endsWith(".md")) return false;
	return ATTACHMENT_EXTENSIONS.test(basename(path).slice(0, -3));
}
