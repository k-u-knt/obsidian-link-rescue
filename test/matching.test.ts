import { test } from "node:test";
import assert from "node:assert/strict";
import {
	NameIndex, applyEdits, isClickToCreateStub, normalizeKey, obsidianLinktext, pickCandidate, replaceLinkTarget,
	rewriteLinkpath, splitSubpath,
} from "../src/matching.ts";

// The typical case: macOS names screenshots with U+202F before "AM"/"PM". Obsidian indexes the file with a
// plain space, but a link that kept U+202F (e.g. copied from Finder) doesn't resolve.
const vaultPath = "Vault/Attachments/Screenshot 2025-03-14 at 9.41.07 AM.png";
const brokenLink = "Screenshot 2025-03-14 at 9.41.07\u202FAM.png";

test("normalizeKey treats lookalike spaces, invisible chars, NFD and case as equal", () => {
	assert.equal(normalizeKey("a\u202Fb"), normalizeKey("A b"));
	assert.equal(normalizeKey("a\u00A0b"), "a b");
	assert.equal(normalizeKey("a\u200Bb"), "ab");
	assert.equal(normalizeKey("Café"), normalizeKey("Café"));
});

test("obsidianLinktext mirrors Obsidian: only U+00A0 is replaced", () => {
	assert.equal(obsidianLinktext(" a\u00A0b "), "a b");
	assert.equal(obsidianLinktext("a\u202Fb"), "a\u202Fb");
});

test("index finds the screenshot from a U+202F link, by name and by path", () => {
	const idx = new NameIndex([vaultPath, "Vault/Notes/Note.md"]);
	assert.deepEqual(idx.find(brokenLink), [vaultPath]);
	assert.deepEqual(idx.find("Attachments/" + brokenLink), [vaultPath]);
	assert.deepEqual(idx.find("Vault/Attachments/" + brokenLink), [vaultPath]);
	assert.deepEqual(idx.find("note"), ["Vault/Notes/Note.md"]);
	assert.deepEqual(idx.find("missing.png"), []);
});

test("links with folders only match at a path boundary, never a same-named file elsewhere", () => {
	const idx = new NameIndex(["Archive/Plan.md", "Projects/Plan.md", "xProjects/Other.md"]);
	assert.deepEqual(idx.find("Projects/Plan"), ["Projects/Plan.md"]);
	assert.deepEqual(new NameIndex(["Archive/Plan.md"]).find("Projects/Plan"), []);
	assert.deepEqual(idx.find("Projects/Other"), []);
});

test("an exact file name beats a same-named note (X.png before X.png.md)", () => {
	const idx = new NameIndex([vaultPath, "Vault/Notes/Screenshot 2025-03-14 at 9.41.07 AM.png.md"]);
	assert.deepEqual(idx.find(brokenLink), [vaultPath]);
});

test("pickCandidate prefers the source note's folder and refuses real ambiguity", () => {
	assert.equal(pickCandidate(["a/x.png"], "b/n.md"), "a/x.png");
	assert.equal(pickCandidate(["a/x.png", "b/x.png"], "b/n.md"), "b/x.png");
	assert.equal(pickCandidate(["a/x.png", "c/x.png"], "b/n.md"), null);
	assert.equal(pickCandidate([], "b/n.md"), null);
});

test("rewriteLinkpath keeps the link's folder depth and extension style", () => {
	assert.equal(rewriteLinkpath(brokenLink, vaultPath), "Screenshot 2025-03-14 at 9.41.07 AM.png");
	assert.equal(rewriteLinkpath("Attachments/" + brokenLink, vaultPath), "Attachments/Screenshot 2025-03-14 at 9.41.07 AM.png");
	assert.equal(rewriteLinkpath("my\u202Fnote", "Notes/my note.md"), "my note");
	assert.equal(rewriteLinkpath("Notes/my\u202Fnote", "Notes/my note.md"), "Notes/my note");
});

test("applyEdits fixes the embed and keeps the ' 300' size", () => {
	const original = `![[${brokenLink}| 300]]`;
	const note = `Intro\n${original}\n\nMore text`;
	const start = note.indexOf(original);
	const { text, applied } = applyEdits(note, [{
		start, end: start + original.length, original,
		oldLinkpath: brokenLink, newLinkpath: rewriteLinkpath(brokenLink, vaultPath),
	}]);
	assert.equal(applied, 1);
	assert.equal(text, "Intro\n![[Screenshot 2025-03-14 at 9.41.07 AM.png| 300]]\n\nMore text");
	assert.ok(!text.includes("\u202F"));
});

test("replaceLinkTarget keeps subpaths and aliases in wikilinks", () => {
	assert.equal(replaceLinkTarget("[[my\u202Fnote#Head|Alias]]", "my\u202Fnote", "my note"), "[[my note#Head|Alias]]");
	assert.equal(replaceLinkTarget("[[other]]", "my\u202Fnote", "my note"), null);
});

test("replaceLinkTarget rewrites the markdown URL, not the alt text", () => {
	const md = `![${brokenLink}](Screenshot%202025-03-14%20at%209.41.07%E2%80%AFAM.png)`;
	assert.equal(replaceLinkTarget(md, brokenLink, "Screenshot 2025-03-14 at 9.41.07 AM.png"),
		`![${brokenLink}](Screenshot%202025-03-14%20at%209.41.07%20AM.png)`);
	assert.equal(replaceLinkTarget(`[t](<a\u202Fb.png> "title")`, "a\u202Fb.png", "a b.png"), `[t](<a b.png> "title")`);
	assert.equal(replaceLinkTarget(`[t](a%E2%80%AFb.md#Sec "x")`, "a\u202Fb.md", "a b.md"), `[t](a%20b.md#Sec "x")`);
});

test("applyEdits skips edits when the note changed", () => {
	const { text, applied } = applyEdits("changed", [{
		start: 0, end: 7, original: "![[x]]", oldLinkpath: "x", newLinkpath: "y",
	}]);
	assert.equal(applied, 0);
	assert.equal(text, "changed");
});

test("applyEdits applies several edits without shifting offsets", () => {
	const a = "[[a\u202Fb]]", c = "[[c\u202Fd]]";
	const note = `${a} and ${c}`;
	const { text, applied } = applyEdits(note, [
		{ start: 0, end: a.length, original: a, oldLinkpath: "a\u202Fb", newLinkpath: "a b" },
		{ start: note.indexOf(c), end: note.length, original: c, oldLinkpath: "c\u202Fd", newLinkpath: "c d" },
	]);
	assert.equal(applied, 2);
	assert.equal(text, "[[a b]] and [[c d]]");
});

test("splitSubpath", () => {
	assert.deepEqual(splitSubpath("Note#Head"), { path: "Note", subpath: "#Head" });
	assert.deepEqual(splitSubpath("x.png"), { path: "x.png", subpath: "" });
});

test("isClickToCreateStub: empty note named after an attachment", () => {
	assert.ok(isClickToCreateStub("Notes/Screenshot 2025-03-14 at 9.41.07 AM.png.md", 0));
	assert.ok(!isClickToCreateStub("Notes/Screenshot.png.md", 12));
	assert.ok(!isClickToCreateStub("Notes/Meeting.md", 0));
	assert.ok(!isClickToCreateStub("Notes/figure.png", 0));
});
