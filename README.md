# English–Amoy Dictionary

A first working edition of Rev. J. Macgowan's *English and Chinese Dictionary of
the Amoy Dialect* (1883): a static, searchable web app built from the scanned
PDF in this repository.

**18,373 entries · 598 printed pages · A–Z browse and instant search**

The app is a prototype for the larger digitization plan in
[dictionary-digitization-plan.md](dictionary-digitization-plan.md). It covers the
MVP described there, including the Chinese characters: the PDF's Han glyphs are
images with no usable text, so they are OCR'd from the page scans and attached
to their entries.

## Run it

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite. The production build is static:

```bash
npm run build
npm run preview
```

`public/dictionary.json` (≈2.6 MB) is the whole dataset and is fetched at
startup.

## What works

- **Search** English headwords, Chinese characters (for example 水 or 打), and,
  from the romanization / gloss text, Amoy romanization (for example `tsun`,
  `khi`, `chhiu`).
- Ranked results: exact headword → prefix → substring → body match, with the
  query highlighted.
- **A–Z browse**, with real entry counts per letter.
- Entry view with headword, the entry's **Chinese characters**, printed page,
  transcribed gloss/romanization, and a direct link to the corresponding page
  in the Internet Archive scan.
- Deep links: `?q=…&letter=A&entry=aback` restores search and entry.
- Responsive split view on desktop, list → detail on mobile.
- Copy-link and an "About this digital edition" note explaining the data.

Searching is entirely client-side; there is no backend.

## Review & edit (git-based CMS)

The OCR'd Chinese is good but not perfect, so there is a review workflow for
checking each entry against the original scan and correcting it by hand. Open
the admin page from the dev server:

```bash
npm run dev
# then open http://localhost:5173/?admin=1
```

- The left column is the **review queue** (filter by verified / edited / all,
  search, and jump by letter). On mobile it becomes a list → editor flow.
- Pick an entry to compare it with the **Open scan ↗** link, fix the headword,
  Chinese characters, or gloss, and tick **Verified** when it matches the page.
- **Save & verify →** writes the correction and advances to the next entry.
- **+ Add entry** records an entry the extractor missed — headword, printed
  page, gloss and Chinese characters — and **Delete entry** removes a spurious
  one. Deleted entries move to the **Deleted** filter, where **Restore entry**
  puts them back along with any earlier edits. Both are ordinary
  `content/edits.json` records, so re-running `npm run data:build` keeps them.

Every save writes to [`content/edits.json`](content/edits.json) — the one
file that is the CMS's content — and re-runs the dataset build, so the served
`dictionary.json` always reflects your edits. Commit that file to version your
corrections; the build merges it on top of the extracted text, so re-running
`npm run data:build` never wipes your manual work. **Discard my edits for this
entry** restores the extracted text for that entry.

The admin page only accepts writes on the dev server (`npm run dev`); a
production build serves it read-only.

## Data pipeline

The source is a scan with a two-column layout and an embedded Latin text layer.
The Chinese glyphs are image data with a broken encoding — the text layer
contains **zero** Han characters — so they are recovered by OCR instead.

```bash
# 1. Extract positioned words from every PDF page (poppler-utils)
pdftotext -bbox-layout English-Amoy-Dictionary.pdf data/raw/dict-bbox.html

# 2. Optional: inspect the reading-order lines
node scripts/extract-lines.mjs

# 3. Build public/dictionary.json (also dumps data/raw/build-lines.json)
node scripts/build-dictionary.mjs

# 4. OCR the Chinese characters from the page images (RapidOCR, 300 dpi)
python3 -m venv .venv && .venv/bin/pip install rapidocr-onnxruntime pillow
.venv/bin/python scripts/ocr-chinese.py            # whole book, ~1 h

# 5. Rebuild so the characters land on their entries
node scripts/build-dictionary.mjs
```

`npm run data:extract` runs steps 1 and 3 (and the intermediate line dump),
`npm run data:build` runs step 3/5.

### Chinese-character OCR

- The book is rendered page by page at 300 dpi with `pdftoppm`, then each
  **text line** is cropped from its column and fed straight to the recognizer
  (`use_det=False, use_rec=True`). Line-by-line avoids the two failure modes of
  whole-page OCR here: detector boxes bridging the two-column gutter, and boxes
  merging two stacked lines of Chinese so characters bleed into the wrong
  entry.
- Line boxes come from `data/raw/build-lines.json`, which the dictionary build
  writes from exactly the lines it splices into entries — so OCR output keys
  (`page | column | y`) match the builder 1:1 and mapping characters back onto
  an entry is a text match, not a coordinate guess.
- Output is `data/raw/ocr-lines.json` (or `ocr-shardN.json` when running
  `--out` shards); the build merges every file it finds. Shards are useful
  because each worker holds its own OCR models — more than two at a time can
  exhaust memory on a 8 GB machine.
- Characters are stored as a `chinese` string per entry, in line order,
  preserving the original forms — no traditional/simplified conversion.

### How entries are found

1. Words are grouped into lines per column. The scan is skewed page to page; the
   left margin is estimated per page and the right column placed one
   column-width (~183 pt) to its right.
2. A line at a column margin that begins with `Capitalized word,` starts an
   entry. English phrase headwords such as *Brother in law* are extended using a
   system word list; stray romanization after a headword (*Anxious kbok-lu*) is
   rejected.
3. Lines are accumulated until the next headword. Layout artifacts (running
   heads, page numbers, page-1 title block, appendix) are dropped.
4. Tokens are lightly cleaned. Macgowan's superscript tone marks are omitted
   because the text layer encodes them inconsistently, and short all-caps glyph
   garbage is removed.
5. Entry ids are stable slugs (`aback`, `aback-2`), and the printed page is
   `pdf page − 14`.

Output schema:

```json
{
  "meta": {
    "title": "…",
    "author": "Rev. J. Macgowan",
    "year": 1883,
    "source": "https://archive.org/details/cu31924023550878","totalEntries": 18373, "letters": [{ "letter": "A", "count": 949 }],
    "note": "…"
  },
  "entries": [
    {
      "id": "aback",
      "headword": "Aback",
      "key": "aback",
      "letter": "A",
      "page": 1,
      "scanPage": 15,
      "body": "nig au, 5i t6 the, taken as ship, …",
      "chinese": "向後到退"
    }
  ]
}
```

## Accuracy and known limitations

This is machine extraction, not a critical edition.

- **Chinese characters come from OCR**, so individual characters can be wrong
  — they are machine-read from 300 dpi crops, not transcribed by hand. The
  recognizer occasionally substitutes a simplified or look-alike form (算盘 for
  printed 算盤) and neighbouring entries can bleed together where lines are
  tight. Every entry still links to the scan, where the printed Chinese can be
  checked. Coverage is reported in the dataset as `meta.ocrCoverage`.
- **OCR noise remains** in headwords (*Abbor* for *Abhor*, *Acfcia*) and bodies.
  There are also stray symbols and split words from the original layout.
- **Some right-column lines may be missed** where the scan's margins shift
  unusually; those lines become part of the preceding entry body.
- **Romanization is approximate.** Tone marks are omitted; it is Macgowan's
  system, not modern Pe̍h-ōe-jī.
- The appendix (medical phrases, pp. 599–612) and errata are excluded from the
  dictionary dataset.

The next steps are a manual review pass of the OCR output and a richer entry
schema with separate headword / romanization / Chinese fields, per the plan
document.

## Project layout

```
src/
  App.tsx                 UI: masthead, search, browse, detail, routing
  lib/dictionary.ts       types, normalization, ranking, snippets, scan links
  styles.css              paper-and-ink design system
scripts/
  build-dictionary.mjs    PDF text layer + OCR → public/dictionary.json
  ocr-chinese.py          page images → Chinese characters per line (RapidOCR)
  extract-lines.mjs       bbox HTML → positioned reading-order lines (debug)
public/dictionary.json    generated dataset
data/raw/                 generated extraction intermediates (git-ignored)
```

## Source and rights

Source: [English and Chinese Dictionary of the Amoy Dialect](https://archive.org/details/cu31924023550878),
Rev. J. Macgowan, 1883. Cornell University Library copy, digitized by the
Internet Archive. The Internet Archive metadata states no known restrictions in
the US. This is an independent prototype, not affiliated with either
institution.
