export interface Entry {
  id: string;
  headword: string;
  key: string;
  letter: string;
  page: number;
  scanPage: number;
  body: string;
  /** Han characters, OCR'd from the page image (scripts/ocr-chinese.py). */
  chinese?: string;
  /** Set by the admin page once a human has checked the entry against the scan. */
  verified?: boolean;
}

export interface LetterCount {
  letter: string;
  count: number;
}

export interface DictionaryMeta {
  title: string;
  author: string;
  year: number;
  source: string;
  totalEntries: number;
  letters: LetterCount[];
  note: string;
  /** Entries a human has verified via content/edits.json (admin page). */
  verifiedCount?: number;
  /** Entries with at least one manual override in content/edits.json. */
  editedCount?: number;
}

export interface DictionaryData {
  meta: DictionaryMeta;
  entries: Entry[];
}

export interface SearchableEntry {
  entry: Entry;
  headwordNorm: string;
  bodyNorm: string;
}

export interface SearchHit {
  entry: Entry;
  score: number;
}

const DIACRITICS = /[\u0300-\u036f]/g;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/** The Han characters contained in a query ("水 tsui" -> "水"). */
export function hanOf(query: string): string {
  return query.match(HAN)?.join("") ?? "";
}

/** Loose comparison form: lower-case, no diacritics, no punctuation. */
export function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildIndex(entries: Entry[]): SearchableEntry[] {
  return entries.map((entry) => ({
    entry,
    headwordNorm: normalizeText(entry.headword),
    bodyNorm: normalizeText(entry.body),
  }));
}

/**
 * Ranked search: exact headword, headword prefix, headword substring, then
 * amoy romanization / definition text. Single-character queries stay in the
 * headword so they do not return the whole dictionary.
 */
export function searchEntries(index: SearchableEntry[], query: string): SearchHit[] {
  const han = hanOf(query);
  const q = normalizeText(query);
  if (!q && !han) return [];
  const hits: SearchHit[] = [];
  for (const item of index) {
    let score = -1;
    if (q) {
      if (item.headwordNorm === q) score = 0;
      else if (item.headwordNorm.startsWith(q)) score = 1;
      else if (item.headwordNorm.includes(q)) score = 2;
      else if (q.length > 1 && item.bodyNorm.includes(q)) score = 3;
    }
    if (han && item.entry.chinese?.includes(han)) {
      const c = item.entry.chinese;
      const hanScore = c === han ? 0 : c.startsWith(han) ? 1 : 2;
      score = score < 0 ? hanScore : Math.min(score, hanScore);
    }
    if (score >= 0) hits.push({ entry: item.entry, score });
  }
  hits.sort(
    (a, b) => a.score - b.score || a.entry.key.length - b.entry.key.length ||
      a.entry.key.localeCompare(b.entry.key),
  );
  return hits;
}

export function snippetFor(entry: Entry, query: string): string {
  const han = hanOf(query);
  if (han && entry.chinese?.includes(han)) {
    const at = entry.chinese.indexOf(han);
    const start = Math.max(0, at - 12);
    const end = Math.min(entry.chinese.length, at + han.length + 36);
    return `${start > 0 ? "…" : ""}${entry.chinese.slice(start, end)}${
      end < entry.chinese.length ? "…" : ""
    }`;
  }
  const body = entry.body;
  const q = query.trim().toLowerCase();
  if (!q || q.length < 2) return body.slice(0, 150);
  const index = body.toLowerCase().indexOf(q);
  if (index < 0) return body.slice(0, 150);
  const start = Math.max(0, index - 45);
  const end = Math.min(body.length, index + q.length + 105);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

export function scanUrl(entry: Entry): string {
  return `https://archive.org/details/cu31924023550878/page/n${entry.scanPage - 1}/mode/2up`;
}
