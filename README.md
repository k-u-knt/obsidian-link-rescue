# Link Rescue

An [Obsidian](https://obsidian.md) plugin for two annoyances in iCloud-synced vaults:

1. **Links that show "could not be found" or "is not created yet" although the file exists**, because
   the link contains an invisible or lookalike character.
2. **Files that iCloud has removed from your Mac** ("Optimize Mac Storage"). Obsidian downloads these
   silently when it shows them. Link Rescue shows their state and lets you choose automatic or manual
   downloads.

**Desktop only for now.** Link repair works on any desktop platform; the iCloud features are macOS only.
iPhone/iPad support is in progress.

## Why links break

macOS names screenshots with an invisible **narrow no-break space** (U+202F) before `AM`/`PM`:

```
Screenshot 2025-03-14 at 9.41.07 AM.png      ← U+202F between "9.41.07" and "AM"
```

Obsidian (checked in 1.13) replaces U+202F and U+00A0 with a normal space in **file names** when it reads
the vault, but in **link text** it only replaces U+00A0. So a link that still contains U+202F, for example
a file name copied from Finder, never resolves, while the same text typed by hand works. Both look
identical on screen. Clicking "Click to create" then makes an empty `….png.md` note.

The same happens with other lookalike spaces, zero-width characters, and names written in a different
Unicode normalization form.

## What it does

- **Repairs broken links.** When a link doesn't resolve and exactly one file matches once invisible
  characters, Unicode normalization and case are ignored, the link is rewritten to the file's exact name.
  Only the link target changes; aliases, sizes (`|300`), headings (`#…`) and markdown links are kept. Links
  with folders only match at a folder boundary, never a same-named file elsewhere.
- **Opens the real file instead of creating an empty note.** Following such a link (click, keyboard,
  context menu, tap) opens the matching file and repairs the link.
- **Status icons** on broken embeds and links:

  | Icon | Meaning |
  |---|---|
  | link | A matching file exists. Click to repair the link |
  | cloud with arrow | The matching file is still in iCloud (macOS) |
  | files | Several files match. Nothing is changed |
  | cloud with slash | No matching file in the vault |

- **iCloud files (macOS).** Images, PDFs, audio and video that are still only in iCloud show a placeholder
  with the file's size, so opening a note doesn't silently download everything it embeds. By default
  (**On hover**) a file downloads only when you rest the pointer on its placeholder, which keeps local storage
  free. **Automatic** downloads them as soon as a note shows them; **Manual** waits for a click. A message says
  when files have been downloaded, and the status bar shows downloads in progress.
- **Vault scan.** The command *Find and repair broken links in vault* lists every repairable link, and the
  empty notes that "Click to create" left behind, and fixes them in one go.

## Commands

- **Repair broken links in current note**
- **Find and repair broken links in vault**
- **Download cloud files embedded in current note** (macOS)
- **Cycle cloud download mode (on hover → automatic → manual)** (macOS)

## Settings

| Setting | Default |
|---|---|
| Repair links when a note opens | on |
| Open the matching file instead of creating an empty note | on |
| iCloud downloads: On hover / Automatic / Manual (macOS) | On hover |
| Notify about iCloud downloads (macOS) | on |
| Show status icons | on |

### Known limits of "On hover"

The plugin holds back embeds (`![[…]]`, `![](…)`) and HTML `<img>`/`<video>`/`<audio>` in notes. A few places in
Obsidian load files by other routes and can still download a cloud-only file: the image lightbox, the Live Preview
image-edit popup, and Bases image values and card covers. In canvas, select a card first; Obsidian covers unselected cards.

### Git users

`git status` (for example from the Git plugin) re-reads files whose iCloud state changed, which downloads
them no matter what this plugin's setting says. To stop that, run this once in the vault folder:

```bash
git config core.checkStat minimal
```

## Installation

Not yet in the community plugin directory. Install with
[BRAT](https://github.com/TfTHacker/obsidian42-brat) using `k-u-knt/obsidian-link-rescue`, or manually:
download `main.js`, `manifest.json` and `styles.css` from the latest release into
`<vault>/.obsidian/plugins/link-rescue/`, then enable **Link Rescue** under Community plugins.

## Disclosures

- The plugin **edits your notes**: it rewrites only the target of links that don't resolve, and only when
  exactly one file matches. Turn off *Repair links when a note opens* to repair only on click or via the
  commands.
- On macOS desktop it reads file metadata (`stat`, including `/usr/bin/stat` for the iCloud "dataless"
  flag) and reads the first byte of iCloud-only files to make iCloud download them. It sends nothing over
  the network itself. These features are disabled on other platforms.
- It wraps Obsidian's internal embed registry and `WorkspaceLeaf.openLinkText` to do the above, and
  restores both when disabled.

## Development

```bash
npm install
npm run dev     # watch build into main.js
npm test        # unit tests for the matching logic
npm run build   # type-check + production build
```

`scripts/icloud.swift` removes or restores local copies of iCloud files for testing:
`swift scripts/icloud.swift status|evict|download <file>...` (evict skips files not yet uploaded).

Releases: `npm version patch` (tags without a "v", via `.npmrc`), `git push --follow-tags`, and GitHub Actions
builds a draft release from the tag.

## License

MIT
