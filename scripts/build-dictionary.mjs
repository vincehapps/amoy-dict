#!/usr/bin/env node
// Build the dictionary dataset from `pdftotext -bbox-layout` output.
//
// The 1883 scan has a two-column layout. The PDF text layer carries the Latin
// (English + Amoy romanization) text; the Chinese characters are image glyphs
// with a broken encoding, so only their garbled artifacts come through. Those
// artifacts are filtered out here, and the app links to the original scan.
import fs from "node:fs";
import path from "node:path";

const SRC = process.argv[2] ?? "data/raw/dict-bbox.html";
const OUT = process.argv[3] ?? "public/dictionary.json";
const RAW_OUT = "data/raw/entries-raw.jsonl";

const FIRST_PAGE = 15; // printed page 1
const LAST_PAGE = 612; // printed page 598; the appendix and errata follow
const PAGE_OFFSET = 14; // pdf page - 14 = printed page
const IA_ID = "cu31924023550878";

const html = fs.readFileSync(SRC, "utf8");

function decode(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// A system word list is used only to decide whether a second/third word in a
// line belongs to an English phrase headword (e.g. "Brother in law") or is a
// stray romanization token (e.g. "Anxious kbok-lu").
const wordList = new Set();
for (const file of ["/usr/share/dict/words", "/usr/share/dict/linux.words"]) {
  if (fs.existsSync(file)) {
    for (const w of fs.readFileSync(file, "utf8").split("\n")) {
      wordList.add(w.trim().toLowerCase());
    }
    break;
  }
}
const isEnglish = (w) => wordList.size === 0 || wordList.has(w.toLowerCase());

const pages = [...html.matchAll(/<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g)].map(
  (m) => {
    const words = [...m[3].matchAll(
      /<word xMin="([\d.\-]+)" yMin="([\d.\-]+)" xMax="([\d.\-]+)" yMax="([\d.\-]+)">([\s\S]*?)<\/word>/g,
    )].map((w) => ({
      x: +w[1],
      y: +w[2],
      x2: +w[3],
      y2: +w[4],
      t: decode(w[5]),
    }));
    return { width: +m[1], height: +m[2], words };
  },
);

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i];
}

// The scan is skewed page to page, so the gutter shifts. Both columns keep a
// near-constant width (~183pt), so find the left margin from where rows start,
// then place the right margin one column-width to the right.
function columnGeometry(words) {
  const rows = [];
  for (const w of words) {
    if (w.y < 48) continue;
    let row = rows.find((r) => Math.abs(r.y - w.y) < 5);
    if (!row) {
      row = { y: w.y, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  const starts = [];
  for (const row of rows) {
    row.words.sort((a, b) => a.x - b.x);
    const x = row.words[0].x;
    if (x < 90) starts.push(x);
  }
  const left = quantile(starts, 0.1) ?? 20;
  const right = Math.min(245, Math.max(195, left + 183));
  return { left, right, boundary: right - 7 };
}

const HEADWORD_RE = /^([A-Z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,3})\s*,/;

function readHeadword(lineText, x, colThresholdL, colThresholdR, isLeft) {
  if (x > (isLeft ? colThresholdL : colThresholdR)) return null;
  const m = lineText.match(HEADWORD_RE);
  if (!m) return null;
  const words = m[1].split(/\s+/);
  const kept = [words[0]];
  for (const w of words.slice(1)) {
    // "Bale a" / "Chip a" are headword + romanization, not phrases.
    if (w.toLowerCase() === "a") break;
    if (!isEnglish(w) && !/^[A-Z]/.test(w)) break;
    kept.push(w);
  }
  return { headword: kept.join(" "), matchLength: m[0].length };
}

function cleanToken(tok) {
  let t = tok
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  // Macgowan's superscript tone marks are inconsistently encoded in the text
  // layer; drop them rather than show corrupted marks.
  t = t.replace(/[\^"°`´]/g, "");
  t = t.replace(/[^\p{L}\p{N}'\-.,;:!?()\[\]/]/gu, "");
  if (!/[A-Za-z]/.test(t)) return "";
  if (/^[A-Za-z]$/.test(t)) return "";
  if (/^\d+$/.test(t)) return "";
  // Chinese glyphs in the broken text layer surface as short all-caps tokens.
  if (/^[A-Z]{1,3}[,.;:!?]?$/.test(t)) return "";
  if ((t.match(/\d/g) ?? []).length >= 2 && /[A-Z]/.test(t)) return "";
  return t;
}

function cleanBody(raw) {
  const tokens = raw
    .split(/\s+/)
    .map(cleanToken)
    .filter(Boolean);
  let text = tokens.join(" ");
  text = text
    .replace(/\s+([,.;:!?)\]])/g, "$1")
    .replace(/([(\[])\s+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:!?\-]+/, "")
    .trim();
  return text;
}

// Chinese characters are not in the text layer; they are OCR'd from the page
// image by scripts/ocr-chinese.py, keyed by page | column | line y.
const OCR_FILES = [
  "data/raw/ocr-lines.json",
  ...fs.readdirSync("data/raw").filter((f) => /^ocr-shard\d+\.json$/.test(f)).map((f) => `data/raw/${f}`),
].filter((f) => fs.existsSync(f));
const ocrForPage = new Map(); // page -> Map(key -> chars)
let ocrDpi = null;
for (const file of OCR_FILES) {
  const ocr = JSON.parse(fs.readFileSync(file, "utf8"));
  ocrDpi ??= ocr.meta?.dpi ?? null;
  for (const [page, lines] of Object.entries(ocr.pages ?? {})) {
    ocrForPage.set(+page, new Map(Object.entries(lines)));
  }
}

function ocrLineChars(line) {
  return ocrForPage.get(line.page)?.get(line.key) ?? null;
}

/**
 * Chinese characters for an entry, in line order. The scan's text layer emits
 * extra fragment lines for the Chinese glyphs themselves; those sit a few
 * points below the line they belong to and would repeat its characters, so a
 * fragment whose band overlaps the previous line and carries almost no Latin
 * text is skipped.
 */
function chineseForEntry(entry) {
  const chunks = [];
  let prevBand = null;
  let prevChars = "";
  for (const { text, line } of entry.parts) {
    const chars = ocrLineChars(line);
    if (!chars) continue;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    const top = line.y - 2;
    const bottom = (line.y2 ?? line.y + 7) + 3;
    const overlap = prevBand
      ? Math.min(bottom, prevBand[1]) - Math.max(top, prevBand[0])
      : 0;
    const overlapFrac = overlap / Math.max(1, bottom - top);
    if (overlapFrac > 0.6 && (latin < 5 || chars === prevChars)) continue;
    chunks.push(chars);
    prevBand = [top, bottom];
    prevChars = chars;
  }
  return chunks.join(" ");
}

// Rebuild lines from positioned words, per column.
const allLines = [];
for (let p = 0; p < pages.length; p++) {
  const pageNo = p + 1;
  if (pageNo < FIRST_PAGE || pageNo > LAST_PAGE) continue;
  const { words } = pages[p];
  const body = words.filter((w) => w.y > 48 && w.y2 < pages[p].height - 8 && w.t.trim());
  const { left: leftMargin, right: rightMargin, boundary } = columnGeometry(body);

  const rows = [];
  for (const w of body) {
    const col = w.x < boundary ? "L" : "R";
    let row = rows.find(
      (r) => r.col === col && Math.abs(r.y - w.y) < 4.5 && Math.abs(r.y2 - w.y2) < 7,
    );
    if (!row) {
      row = { col, y: w.y, y2: w.y2, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.sort((a, b) => (a.col === b.col ? a.y - b.y : a.col === "L" ? -1 : 1));

  for (const r of rows) {
    r.words.sort((a, b) => a.x - b.x);
    const text = r.words.map((w) => w.t).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    allLines.push({
      page: pageNo,
      col: r.col,
      y: r.y,
      y2: r.y2,
      x: r.words[0].x,
      // The OCR pass keys every line by page + column + rounded y, so the two
      // runs must share this exact string.
      key: `${r.col}|${r.y.toFixed(1)}`,
      text,
      boundary,
      leftMargin,
      rightMargin,
    });
  }
}

const entries = [];
let current = null;
const rawLines = [];

const HEADER_RE = /^(?:\[\s*\d+\s*\]|\[\s*J?\s*\]|\d{1,3}|[A-Z]{2,4})$/;

for (const line of allLines) {
  // Page 1 of the dictionary carries the book's title block above the entries.
  if (line.page === FIRST_PAGE && line.y < 230) continue;
  if (HEADER_RE.test(line.text)) continue;
  if (/^[^A-Za-z]*$/.test(line.text)) continue;

  const isLeft = line.col === "L";
  const thresholdL = line.leftMargin + 20;
  const thresholdR = line.rightMargin + 14;
  const head = readHeadword(line.text, line.x, thresholdL, thresholdR, isLeft);

  if (head) {
    if (current) entries.push(current);
    const restOfLine = line.text
      .slice(head.matchLength)
      .replace(/^\s*[,;]\s*/, "")
      .trim();
    current = {
      headword: head.headword,
      page: line.page,
      pdfPage: line.page,
      parts: restOfLine ? [{ text: restOfLine, line }] : [],
      raw: [line.text],
    };
  } else if (current) {
    current.parts.push({ text: line.text, line });
    current.raw.push(line.text);
  }
}
if (current) entries.push(current);

// Hand the line boxes that belong to entries to the OCR pass; it crops those
// strips from the page image and reads the Chinese characters out of them.
const usedLines = new Map();
for (const e of entries) {
  for (const { line } of e.parts) {
    usedLines.set(`${line.page}|${line.key}`, {
      page: e.page,
      col: line.col,
      key: line.key,
      y: line.y,
      y2: line.y2,
      text: line.text,
    });
  }
}
const LINES_OUT = "data/raw/build-lines.json";
fs.mkdirSync(path.dirname(LINES_OUT), { recursive: true });
fs.writeFileSync(
  LINES_OUT,
  JSON.stringify({ lines: [...usedLines.values()].sort((a, b) => a.page - b.page || a.y - b.y) }),
);

// Dedupe ids, normalize, and drop obvious noise.
const seen = new Map();
let output = [];
for (const e of entries) {
  const headword = e.headword.replace(/\s+/g, " ").trim();
  if (!headword) continue;
  const letter = headword[0].toUpperCase();
  if (!/[A-Z]/.test(letter)) continue;

  // Drop stray romanization/garble lines that look like headwords.
  const bare = headword.replace(/[^A-Za-z]/g, "");
  if (!/[aeiouy]/i.test(bare) && !/^(?:A|I)$/.test(headword)) continue;
  if (/^[A-Z]{1,3}$/.test(headword) && !/^(?:A|I)$/.test(headword)) continue;
  if (headword.length === 2 && !isEnglish(headword)) continue;
  if (headword.split(" ").length > 3) continue;
  // A lone "A" or "I" is a genuine entry once; repeats are fragments of
  // longer headwords that the margin test misread.
  if (headword.length === 1 && seen.has(headword.toLowerCase())) continue;
  // "A kim tsun" / "A-ggrandise": romanization or a broken hyphen at the margin.
  if (/^A[\s-]/.test(headword)) continue;

  let body = "";
  for (const part of e.parts) {
    const next = part.text.trim();
    if (!next) continue;
    if (body.endsWith("-")) body += next;
    else body += (body ? " " : "") + next;
  }
  body = cleanBody(body);
  if (!body) continue;

  const chinese = chineseForEntry(e);

  const key = headword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  const id = n === 1 ? key : `${key}-${n}`;
  const printedPage = e.page - PAGE_OFFSET;
  output.push({
    id,
    headword,
    key,
    letter,
    page: printedPage,
    scanPage: e.page,
    body,
    ...(chinese ? { chinese } : {}),
  });
  rawLines.push(JSON.stringify({ id, headword, page: printedPage, raw: e.raw.join("\n") }));
}

// Manual corrections live in content/edits.json — the git-tracked content of
// the admin CMS. Overrides are applied by id after extraction, so rerunning
// this build never loses reviewed edits. `verified` marks an entry a human
// has checked against the scan. The file also carries entries the extractor
// missed (`added`) and entries the reviewer removed (`deleted`).
const EDITS_SRC = "content/edits.json";
let editsDoc = { version: 1, entries: {} };
if (fs.existsSync(EDITS_SRC)) {
  try {
    editsDoc = JSON.parse(fs.readFileSync(EDITS_SRC, "utf8"));
  } catch (err) {
    console.error(`warning: could not parse ${EDITS_SRC}: ${err.message}`);
  }
}
const edits = editsDoc.entries ?? {};
let editedCount = 0;
const deletedIds = new Set();
for (const entry of output) {
  const edit = edits[entry.id];
  if (!edit || typeof edit !== "object") continue;
  // A deleted entry leaves the dataset entirely; the admin keeps a snapshot
  // of it in the same record so it can still be listed and restored.
  if (edit.deleted) {
    deletedIds.add(entry.id);
    continue;
  }
  editedCount++;
  if (typeof edit.headword === "string" && edit.headword.trim()) {
    entry.headword = edit.headword.trim();
    const letter = entry.headword[0].toUpperCase();
    if (/[A-Z]/.test(letter)) entry.letter = letter;
  }
  if (typeof edit.body === "string") entry.body = edit.body;
  if (typeof edit.chinese === "string") {
    if (edit.chinese.trim()) entry.chinese = edit.chinese.trim();
    else delete entry.chinese;
  }
  if (edit.verified) entry.verified = true;
}
output = output.filter((entry) => !deletedIds.has(entry.id));

// Entries added by hand in the admin never come out of the PDF, so they are
// rebuilt from their edit record with the same shape as extracted ones.
for (const [id, edit] of Object.entries(edits)) {
  if (!edit || typeof edit !== "object" || !edit.added || edit.deleted) continue;
  if (output.some((entry) => entry.id === id)) {
    console.warn(`warning: added entry "${id}" collides with an extracted entry; keeping the extracted one`);
    continue;
  }
  const headword =
    typeof edit.headword === "string" ? edit.headword.replace(/\s+/g, " ").trim() : "";
  if (!headword) {
    console.warn(`warning: added entry "${id}" has no headword; skipping`);
    continue;
  }
  const letter = headword[0].toUpperCase();
  if (!/[A-Z]/.test(letter)) {
    console.warn(`warning: added entry "${id}" must start with a letter; skipping`);
    continue;
  }
  const page = Number.isInteger(edit.page) && edit.page > 0 ? edit.page : 0;
  if (!page) console.warn(`warning: added entry "${id}" has no printed page; its scan link will be wrong`);
  const body = typeof edit.body === "string" ? edit.body : "";
  const chinese = typeof edit.chinese === "string" ? edit.chinese.trim() : "";
  const key =
    headword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || id;
  output.push({
    id,
    headword,
    key,
    letter,
    page,
    scanPage: page + PAGE_OFFSET,
    body,
    ...(chinese ? { chinese } : {}),
    ...(edit.verified ? { verified: true } : {}),
  });
  editedCount++;
}

// The scan's text layer occasionally scrambles the order of nearby lines;
// sort the finished dataset so A–Z browsing matches the printed alphabet.
output.sort((a, b) => a.key.localeCompare(b.key));

const letters = {};
for (const e of output) letters[e.letter] = (letters[e.letter] ?? 0) + 1;

const dataset = {
  meta: {
    title: "English and Chinese Dictionary of the Amoy Dialect",
    author: "Rev. J. Macgowan",
    year: 1883,
    source: `https://archive.org/details/${IA_ID}`,
    totalEntries: output.length,
    letters: Object.keys(letters)
      .sort()
      .map((letter) => ({ letter, count: letters[letter] })),
    note:
      "Automatically extracted from the scanned 1883 edition. English headwords and the Amoy romanization come from the PDF text layer; the Chinese characters are OCR'd from the page image and may contain recognition errors.",
    ocrCoverage: output.filter((e) => e.chinese).length,
    ocrDpi,
    verifiedCount: output.filter((e) => e.verified).length,
    editedCount,
  },
  entries: output,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(dataset));
fs.writeFileSync(RAW_OUT, rawLines.join("\n") + "\n");
console.log(`entries: ${output.length}`);
console.log(`with Chinese: ${dataset.meta.ocrCoverage} (${Math.round((dataset.meta.ocrCoverage / output.length) * 100)}%)`);
console.log(`letters: ${dataset.meta.letters.map((l) => `${l.letter}:${l.count}`).join(" ")}`);
console.log(`size: ${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB -> ${OUT}`);
