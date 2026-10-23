import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));
const EDITS_FILE = path.join(root, "content", "edits.json");

interface EntryEdit {
  headword?: string;
  body?: string;
  chinese?: string;
  verified?: boolean;
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

/**
 * The admin page's CMS endpoint: GET returns content/edits.json, POST applies
 * one entry's patch (or `reset`) to it, then reruns the dataset build so
 * public/dictionary.json reflects the edit. Available on the dev server only,
 * which is why the admin page works under `npm run dev` and is read-only in a
 * production build.
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
            patch?: Partial<EntryEdit>;
          };
          try {
            body = JSON.parse(raw);
          } catch {
            send(400, { error: "invalid JSON" });
            return;
          }
          const id = body.id;
          if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
            send(400, { error: "invalid entry id" });
            return;
          }

          try {
            const doc = loadEdits();
            if (body.reset === true) {
              delete doc.entries[id];
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
              send(400, { error: "missing patch or reset" });
              return;
            }
            saveEdits(doc);

            // Rebuild so the served dataset carries the edit right away.
            execFileSync(process.execPath, [path.join(root, "scripts/build-dictionary.mjs")], {
              cwd: root,
              stdio: "pipe",
            });
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
