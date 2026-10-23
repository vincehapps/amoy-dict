import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const EDITS_FILE = path.join(root, "content", "edits.json");
const DATASET_FILE = path.join(root, "public", "dictionary.json");
const REBUILD_SCRIPT = path.join(root, "scripts", "build-dictionary.mjs");
// Printed page numbers in the dataset run 1–598 (PDF pages 15–612).
const MAX_PRINTED_PAGE = 598;

/** A copy of an entry as it was when the reviewer deleted it. */
interface EntrySnapshot {
  id: string;
  headword: string;
  key: string;
  letter: string;
  page: number;
  scanPage: number;
  body: string;
  chinese?: string;
  verified?: boolean;
}

interface EntryEdit {
  headword?: string;
  body?: string;
  chinese?: string;
  /** Printed page; only meaningful for `added` entries (no extracted page). */
  page?: number;
  verified?: boolean;
  /** Added by hand in the admin — not produced by the PDF extractor. */
  added?: boolean;
  /** Removed from the dataset; `snapshot` keeps it listable and restorable. */
  deleted?: boolean;
  snapshot?: EntrySnapshot;
}

interface EditsDoc {
  version: number;
  entries: Record<string, EntryEdit>;
}

function loadEdits(): EditsDoc {
  try {
    const doc = JSON.parse(fs.readFileSync(EDITS_FILE, "utf8"));
    return { version: doc.version ?? 1, entries: doc.entries ?? {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveEdits(doc: EditsDoc): void {
  fs.mkdirSync(path.dirname(EDITS_FILE), { recursive: true });
  const tmp = `${EDITS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  fs.renameSync(tmp, EDITS_FILE);
}

function loadDatasetEntries(): EntrySnapshot[] {
  try {
    const doc = JSON.parse(fs.readFileSync(DATASET_FILE, "utf8")) as {
      entries?: EntrySnapshot[];
    };
    return Array.isArray(doc.entries) ? doc.entries : [];
  } catch {
    return [];
  }
}

/** Re-run the dataset build so the served dictionary.json carries the change. */
function rebuildDataset(): void {
  execFileSync(process.execPath, [REBUILD_SCRIPT], { cwd: root, stdio: "pipe" });
}

/**
 * The admin page's CMS endpoint: GET returns content/edits.json, POST applies
 * one action to it — an entry `patch`, `reset`, `delete`, `restore`, or a new
 * entry via `add` — then reruns the dataset build so public/dictionary.json
 * reflects the change. Available on the dev server only, which is why the
 * admin page works under `npm run dev` and is read-only in a production build.
 */
function adminCms(): Plugin {
  return {
    name: "admin-cms",
    configureServer(server) {
      server.middlewares.use("/__api/edits", (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(body));
        };

        if (req.method === "GET") {
          send(200, loadEdits());
          return;
        }
        if (req.method !== "POST") {
          send(405, { error: "method not allowed" });
          return;
        }

        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
          if (raw.length > 1_000_000) req.destroy();
        });
        req.on("end", () => {
          let body: {
            id?: unknown;
            reset?: unknown;
            delete?: unknown;
            restore?: unknown;
            patch?: Partial<EntryEdit>;
            add?: {
              headword?: unknown;
              page?: unknown;
              body?: unknown;
              chinese?: unknown;
              verified?: unknown;
            };
          };
          try {
            body = JSON.parse(raw);
          } catch {
            send(400, { error: "invalid JSON" });
            return;
          }

          try {
            const doc = loadEdits();

            // A new entry carries no id: derive it from the headword the way
            // the extractor does and suffix it until it is free, so a hand
            // added entry can never shadow an extracted or deleted one.
            if (body.add && typeof body.add === "object") {
              const add = body.add;
              const headword =
                typeof add.headword === "string"
                  ? add.headword.replace(/\s+/g, " ").trim()
                  : "";
              if (!headword) {
                send(400, { error: "headword is required" });
                return;
              }
              if (!/^[A-Za-z]/.test(headword)) {
                send(400, { error: "headword must start with a letter" });
                return;
              }
              if (headword.length > 80) {
                send(400, { error: "headword is too long" });
                return;
              }
              const page = add.page;
              if (
                typeof page !== "number" ||
                !Number.isInteger(page) ||
                page < 1 ||
                page > MAX_PRINTED_PAGE
              ) {
                send(400, { error: `printed page must be a number from 1 to ${MAX_PRINTED_PAGE}` });
                return;
              }
              const gloss = typeof add.body === "string" ? add.body.trim() : "";
              const chinese = typeof add.chinese === "string" ? add.chinese.trim() : "";

              const taken = new Set<string>(loadDatasetEntries().map((entry) => entry.id));
              for (const key of Object.keys(doc.entries)) taken.add(key);
              const base =
                headword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
                "entry";
              let id = base;
              for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

              const record: EntryEdit = { added: true, headword, page };
              if (gloss) record.body = gloss;
              if (chinese) record.chinese = chinese;
              if (add.verified === true) record.verified = true;
              doc.entries[id] = record;

              saveEdits(doc);
              rebuildDataset();
              send(200, { ok: true, edits: doc, id });
              return;
            }

            const id = body.id;
            if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
              send(400, { error: "invalid entry id" });
              return;
            }

            if (body.reset === true) {
              delete doc.entries[id];
            } else if (body.delete === true) {
              const record = doc.entries[id] ?? {};
              if (!record.deleted) {
                const entry = loadDatasetEntries().find((item) => item.id === id);
                if (!entry) {
                  send(404, { error: "entry not found" });
                  return;
                }
                // Keep the entry's current content so the admin can still
                // show what was deleted once the rebuild drops it.
                doc.entries[id] = { ...record, deleted: true, snapshot: entry };
              }
            } else if (body.restore === true) {
              const record = doc.entries[id];
              if (!record?.deleted) {
                send(400, { error: "entry is not deleted" });
                return;
              }
              const next: EntryEdit = { ...record };
              delete next.deleted;
              delete next.snapshot;
              // An entry with nothing left to say goes back to pure extraction.
              if (Object.keys(next).length > 0) doc.entries[id] = next;
              else delete doc.entries[id];
            } else if (body.patch && typeof body.patch === "object") {
              const patch = body.patch;
              const next: EntryEdit = { ...(doc.entries[id] ?? {}) };
              for (const field of ["headword", "body", "chinese"] as const) {
                if (typeof patch[field] === "string") next[field] = patch[field];
              }
              if (patch.verified === true) next.verified = true;
              else if (patch.verified === false) delete next.verified;
              if (Object.keys(next).length > 0) doc.entries[id] = next;
              else delete doc.entries[id];
            } else {
              send(400, { error: "missing patch, reset, delete, restore, or add" });
              return;
            }
            saveEdits(doc);

            // Rebuild so the served dataset carries the edit right away.
            rebuildDataset();
            send(200, { ok: true, edits: doc });
          } catch (err) {
            // The edits file is already written; report the build failure so
            // the admin page can show it rather than pretend the save worked.
            send(500, { error: `rebuild failed: ${(err as Error).message}` });
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), adminCms()],
});
