#!/usr/bin/env node
// Parse `pdftotext -bbox-layout` output into reading-order lines.
// Each dictionary page is a two-column layout; lines are grouped per column.
import fs from "node:fs";

const SRC = process.argv[2] ?? "data/raw/dict-bbox.html";
const OUT = process.argv[3] ?? "data/raw/lines.json";

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

const pages = [];
const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
let m;
while ((m = pageRe.exec(html))) {
  const width = +m[1];
  const height = +m[2];
  const words = [];
  const wordRe = /<word xMin="([\d.\-]+)" yMin="([\d.\-]+)" xMax="([\d.\-]+)" yMax="([\d.\-]+)">([\s\S]*?)<\/word>/g;
  let w;
  while ((w = wordRe.exec(m[3]))) {
    words.push({
      x: +w[1],
      y: +w[2],
      x2: +w[3],
      y2: +w[4],
      t: decode(w[5]),
    });
  }
  pages.push({ page: pages.length + 1, width, height, words });
}

const lines = [];
for (const { page, width, height, words } of pages) {
  // Ignore the scanned page edges (stray marks at the very top/bottom).
  const usable = words.filter(
    (w) => w.y > 40 && w.y2 < height - 12 && w.t.trim() !== "",
  );
  const rows = [];
  for (const w of usable) {
    const col = w.x < width / 2 ? "L" : "R";
    let row = rows.find(
      (r) => r.col === col && Math.abs(r.y - w.y) < 4.5 && Math.abs(r.y2 - w.y2) < 7,
    );
    if (!row) {
      row = { col, y: w.y, y2: w.y2, words: [] };
      rows.push(row);
    }
    row.words.push(w);
  }
  rows.sort((a, b) =>
    a.col === b.col ? a.y - b.y : a.col === "L" ? -1 : 1,
  );
  for (const r of rows) {
    r.words.sort((a, b) => a.x - b.x);
    const text = r.words.map((w) => w.t).join(" ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    lines.push({
      page,
      col: r.col,
      y: +r.y.toFixed(1),
      y2: +r.y2.toFixed(1),
      x: +r.words[0].x.toFixed(1),
      text,
    });
  }
}

fs.writeFileSync(OUT, JSON.stringify({ pages: pages.length, lines }, null, 0));
console.log(`pages: ${pages.length}, lines: ${lines.length} -> ${OUT}`);
