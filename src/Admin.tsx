import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildIndex,
  scanUrl,
  searchEntries,
  type DictionaryData,
  type Entry,
} from "./lib/dictionary";

/**
 * Admin review page — the editing half of the git-based CMS.
 *
 * Reads the generated dataset plus content/edits.json (via the dev-server
 * endpoint in vite.config.ts), lets you check each entry against the original
 * scan, edit headword / Chinese / gloss, and mark it verified. Every save
 * writes content/edits.json — the git-tracked file — and rebuilds the served
 * dataset, so committing that one file versions all manual corrections.
 */

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

type QueueFilter = "unverified" | "verified" | "edited" | "all";

const FILTERS: { id: QueueFilter; label: string }[] = [
  { id: "unverified", label: "Unverified" },
  { id: "verified", label: "Verified" },
  { id: "edited", label: "Edited" },
  { id: "all", label: "All" },
];

const PAGE_SIZE = 60;

function hasContentEdit(edit: EntryEdit | undefined): boolean {
  return Boolean(
    edit &&
      (edit.headword !== undefined ||
        edit.body !== undefined ||
        edit.chinese !== undefined),
  );
}

/** Mirror of what scripts/build-dictionary.mjs does with an override. */
function applyPatchToEntry(entry: Entry, patch: EntryEdit): Entry {
  const next: Entry = { ...entry };
  if (patch.headword?.trim()) {
    next.headword = patch.headword.trim();
    const letter = next.headword[0].toUpperCase();
    if (/[A-Z]/.test(letter)) next.letter = letter;
  }
  if (typeof patch.body === "string") next.body = patch.body;
  if (typeof patch.chinese === "string") {
    if (patch.chinese.trim()) next.chinese = patch.chinese.trim();
    else delete next.chinese;
  }
  if (patch.verified) next.verified = true;
  else delete next.verified;
  return next;
}

/** Keep the admin URL shareable across reloads (`?admin=1&entry=…`). */
function setUrlEntry(id: string | null): void {
  const url = new URL(window.location.href);
  url.searchParams.set("admin", "1");
  if (id) url.searchParams.set("entry", id);
  else url.searchParams.delete("entry");
  window.history.replaceState(null, "", url);
}

export default function Admin() {
  const [data, setData] = useState<DictionaryData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [edits, setEdits] = useState<EditsDoc>({ version: 1, entries: {} });
  const [readOnly, setReadOnly] = useState(false);
  const [filter, setFilter] = useState<QueueFilter>("unverified");
  const [letter, setLetter] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const param = new URLSearchParams(window.location.search).get("entry");
    return param || null;
  });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [form, setForm] = useState({ headword: "", body: "", chinese: "" });
  const [formVerified, setFormVerified] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const syncedId = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`${import.meta.env.BASE_URL}dictionary.json`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<DictionaryData>;
      })
      .then((dictionary) => {
        if (alive) setData(dictionary);
      })
      .catch(() => {
        if (alive) setLoadError(true);
      });
    // The edits endpoint only exists on the dev server; a production build
    // serves the admin page read-only with an explanation instead.
    fetch(`/__api/edits?t=${Date.now()}`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<EditsDoc>;
      })
      .then((doc) => {
        if (alive) setEdits({ version: doc.version ?? 1, entries: doc.entries ?? {} });
      })
      .catch(() => {
        if (alive) setReadOnly(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const index = useMemo(() => (data ? buildIndex(data.entries) : []), [data]);
  const byId = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const entry of data?.entries ?? []) map.set(entry.id, entry);
    return map;
  }, [data]);

  /** Entries within the current letter + search scope, before the status filter. */
  const scoped = useMemo(() => {
    if (!data) return [];
    const q = query.trim();
    if (!q) {
      return letter
        ? data.entries.filter((entry) => entry.letter === letter)
        : data.entries;
    }
    const ids = new Set(searchEntries(index, q).map((hit) => hit.entry.id));
    return data.entries.filter(
      (entry) => ids.has(entry.id) && (!letter || entry.letter === letter),
    );
  }, [data, index, letter, query]);

  const counts = useMemo(() => {
    const c = { unverified: 0, verified: 0, edited: 0, all: 0 };
    for (const entry of scoped) {
      const edit = edits.entries[entry.id];
      c.all += 1;
      if (edit?.verified) c.verified += 1;
      else c.unverified += 1;
      if (hasContentEdit(edit)) c.edited += 1;
    }
    return c;
  }, [scoped, edits]);

  const queue = useMemo(
    () =>
      scoped.filter((entry) => {
        const edit = edits.entries[entry.id];
        const verified = Boolean(edit?.verified);
        if (filter === "unverified") return !verified;
        if (filter === "verified") return verified;
        if (filter === "edited") return hasContentEdit(edit);
        return true;
      }),
    [scoped, edits, filter],
  );

  const selectedEntry = selectedId ? byId.get(selectedId) : undefined;
  const selectedEdit = selectedId ? edits.entries[selectedId] : undefined;

  const dirty = selectedEntry
    ? form.headword !== selectedEntry.headword ||
        form.body !== selectedEntry.body ||
        form.chinese !== (selectedEntry.chinese ?? "") ||
        formVerified !== Boolean(selectedEdit?.verified)
    : false;

  // Load the form when the selection changes (not when data/edits refresh
  // underneath it — after a save the form holds what the server now has).
  useEffect(() => {
    if (!selectedId || syncedId.current === selectedId) return;
    const entry = byId.get(selectedId);
    if (!entry) return;
    syncedId.current = selectedId;
    setForm({
      headword: entry.headword,
      body: entry.body,
      chinese: entry.chinese ?? "",
    });
    setFormVerified(Boolean(edits.entries[selectedId]?.verified));
    setSaveState("idle");
  }, [selectedId, byId, edits]);

  useEffect(() => {
    if (saveState !== "saved") return;
    const timer = window.setTimeout(() => setSaveState("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [saveState]);

  const jumpTo = useCallback((id: string) => {
    syncedId.current = null;
    setSelectedId(id);
    setSaveState("idle");
    setVisible(PAGE_SIZE);
    setUrlEntry(id);
  }, []);

  const select = useCallback(
    (id: string) => {
      if (dirty && id !== selectedId && !window.confirm("Discard unsaved changes?")) {
        return;
      }
      jumpTo(id);
    },
    [dirty, selectedId, jumpTo],
  );

  const clearSelection = useCallback(() => {
    syncedId.current = null;
    setSelectedId(null);
    setSaveState("idle");
    setUrlEntry(null);
  }, []);

  async function save(opts: { verify?: boolean } = {}) {
    if (!selectedEntry || readOnly || saveState === "saving") return;
    const id = selectedEntry.id;
    const patch: EntryEdit = {
      headword: form.headword,
      body: form.body,
      chinese: form.chinese,
      verified: opts.verify ? true : formVerified,
    };
    setSaveState("saving");
    setSaveError("");
    try {
      const response = await fetch("/__api/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, patch }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        edits?: EditsDoc;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setEdits(payload.edits ?? { version: 1, entries: {} });
      setData((prev) =>
        prev
          ? {
              ...prev,
              entries: prev.entries.map((entry) =>
                entry.id === id ? applyPatchToEntry(entry, patch) : entry,
              ),
            }
          : prev,
      );
      syncedId.current = id;
      setFormVerified(patch.verified === true);
      setSaveState("saved");
      if (opts.verify) {
        // Advance through the queue using the pre-update order, where this
        // entry sits at its current position.
        const position = queue.findIndex((entry) => entry.id === id);
        const next = position >= 0 ? queue[position + 1] : undefined;
        if (next) jumpTo(next.id);
        else clearSelection();
      }
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  /** Move forward (or back) through the queue; `select` guards unsaved work. */
  function advance(step: 1 | -1) {
    const position = queue.findIndex((entry) => entry.id === selectedId);
    const next =
      position >= 0
        ? queue[position + step]
        : queue[step === 1 ? 0 : queue.length - 1];
    if (next) select(next.id);
    else clearSelection();
  }

  async function discardEdits() {
    if (!selectedEntry || readOnly) return;
    if (!window.confirm("Discard all manual edits for this entry and restore the extracted text?")) {
      return;
    }
    const id = selectedEntry.id;
    setSaveState("saving");
    setSaveError("");
    try {
      const response = await fetch("/__api/edits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, reset: true }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        edits?: EditsDoc;
        error?: string;
      };
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      setEdits(payload.edits ?? { version: 1, entries: {} });
      // The rebuild restored the extracted values; re-fetch so the form and
      // list show them again.
      const fresh = (await fetch(`${import.meta.env.BASE_URL}dictionary.json?t=${Date.now()}`)) as Response;
      if (!fresh.ok) throw new Error(`HTTP ${fresh.status}`);
      const dictionary = (await fresh.json()) as DictionaryData;
      setData(dictionary);
      const entry = dictionary.entries.find((item) => item.id === id);
      syncedId.current = id;
      if (entry) {
        setForm({
          headword: entry.headword,
          body: entry.body,
          chinese: entry.chinese ?? "",
        });
      }
      setFormVerified(false);
      setSaveState("saved");
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }

  if (loadError) {
    return (
      <div className="status-screen">
        <p className="status-kicker">Admin</p>
        <h1>The dictionary could not be loaded.</h1>
        <p>Check that the dataset is present and reload the page.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="status-screen" role="status" aria-live="polite">
        <p className="status-kicker">Admin</p>
        <h1>Opening the review queue…</h1>
      </div>
    );
  }

  const total = data.meta.totalEntries;
  const verifiedTotal = data.entries.filter(
    (entry) => edits.entries[entry.id]?.verified,
  ).length;
  const progress = total ? Math.round((verifiedTotal / total) * 100) : 0;
  const shown = queue.slice(0, visible);
  const remaining = queue.length - shown.length;
  const queuePosition = selectedId
    ? queue.findIndex((entry) => entry.id === selectedId)
    : -1;

  return (
    <div className={`admin${selectedEntry ? " has-selection" : ""}`}>
      <header className="admin-bar">
        <div className="admin-bar-top">
          <a className="admin-exit" href="./?letter=A">
            ← Dictionary
          </a>
          <span className="admin-heading">Review &amp; edit</span>
          <span className="admin-mode" data-read-only={readOnly || undefined}>
            {readOnly ? "Read-only" : "CMS"}
          </span>
        </div>
        <div className="admin-progress">
          <div
            className="admin-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={verifiedTotal}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          <p>
            <strong>{verifiedTotal.toLocaleString()}</strong> of{" "}
            {total.toLocaleString()} verified ({progress}%) ·{" "}
            {counts.edited.toLocaleString()} edited
          </p>
        </div>
      </header>

      {readOnly ? (
        <p className="admin-banner">
          Read-only: saving needs the dev server. Run{" "}
          <code>npm run dev</code> and open this page from it — production
          builds never accept edits.
        </p>
      ) : null}

      <div className="admin-controls">
        <div className="admin-chips" role="group" aria-label="Filter by status">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`admin-chip${filter === item.id ? " is-active" : ""}`}
              aria-pressed={filter === item.id}
              onClick={() => {
                setFilter(item.id);
                setVisible(PAGE_SIZE);
              }}
            >
              {item.label}
              <span>{counts[item.id].toLocaleString()}</span>
            </button>
          ))}
        </div>
        <div className="admin-controls-row">
          <input
            type="search"
            className="admin-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setVisible(PAGE_SIZE);
            }}
            placeholder="Search headword, 汉字, romanization"
            aria-label="Search the review queue"
            autoComplete="off"
            spellCheck={false}
          />
          <select
            className="admin-letter"
            value={letter}
            onChange={(event) => {
              setLetter(event.target.value);
              setVisible(PAGE_SIZE);
            }}
            aria-label="Filter by letter"
          >
            <option value="">All letters</option>
            {data.meta.letters.map((item) => (
              <option key={item.letter} value={item.letter}>
                {item.letter} ({item.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="admin-body">
        <section className="admin-queue" aria-label="Entries to review">
          {queue.length === 0 ? (
            <div className="admin-empty">
              <h3>Nothing in this queue</h3>
              <p>
                {filter === "unverified"
                  ? "Everything in scope is verified — nice work."
                  : "No entries match this filter."}
              </p>
              <button
                type="button"
                onClick={() => {
                  setFilter("all");
                  setLetter("");
                  setQuery("");
                }}
              >
                Show all entries
              </button>
            </div>
          ) : (
            <>
              <ol className="admin-queue-list">
                {shown.map((entry, i) => {
                  const edit = edits.entries[entry.id];
                  const verified = Boolean(edit?.verified);
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={`admin-item${entry.id === selectedId ? " is-selected" : ""}`}
                        onClick={() => select(entry.id)}
                        aria-current={entry.id === selectedId ? "true" : undefined}
                      >
                        <span className="admin-item-main">
                          <span className="admin-item-headword">
                            {entry.headword}
                            {hasContentEdit(edit) ? (
                              <em className="admin-item-edited">edited</em>
                            ) : null}
                          </span>
                          {entry.chinese ? (
                            <span className="admin-item-chinese" lang="zh-Hant">
                              {entry.chinese}
                            </span>
                          ) : null}
                        </span>
                        <span className="admin-item-meta">
                          <span className="admin-item-pos">
                            {(visible - PAGE_SIZE + i + 1).toLocaleString()}
                          </span>
                          <span
                            className={`admin-item-check${verified ? " is-verified" : ""}`}
                            aria-label={verified ? "Verified" : "Not verified"}
                          >
                            {verified ? "✓" : ""}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
              {remaining > 0 ? (
                <button
                  type="button"
                  className="admin-show-more"
                  onClick={() => setVisible((count) => count + PAGE_SIZE)}
                >
                  Show {Math.min(PAGE_SIZE, remaining)} more
                  <span>{remaining.toLocaleString()} remaining</span>
                </button>
              ) : (
                <p className="list-end">
                  End of {queue.length.toLocaleString()} entries
                </p>
              )}
            </>
          )}
        </section>

        <section className="admin-editor" aria-label="Entry editor">
          {selectedEntry ? (
            <div
              className="admin-editor-inner"
              data-admin-form={dirty ? "dirty" : undefined}
            >
              <div className="admin-editor-top">
                <button
                  className="admin-back"
                  type="button"
                  onClick={clearSelection}
                >
                  ← Queue
                </button>
                <span className="admin-editor-pos">
                  {queuePosition >= 0
                    ? `${(queuePosition + 1).toLocaleString()} of ${queue.length.toLocaleString()} in queue`
                    : "Not in the current filter"}
                </span>
                <span
                  className={`admin-editor-status${
                    selectedEdit?.verified ? " is-verified" : ""
                  }`}
                >
                  {selectedEdit?.verified ? "Verified ✓" : "Not verified"}
                </span>
              </div>

              <div className="admin-editor-heading">
                <h2>{form.headword || selectedEntry.headword}</h2>
                <span className="admin-editor-page">
                  printed page {selectedEntry.page}
                </span>
                <a
                  className="source-link"
                  href={scanUrl(selectedEntry)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open scan ↗
                </a>
              </div>

              <label className="admin-field">
                <span>Headword</span>
                <input
                  type="text"
                  value={form.headword}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, headword: event.target.value }))
                  }
                  spellCheck={false}
                  autoComplete="off"
                />
                <small>Leave blank to keep the extracted headword.</small>
              </label>

              <label className="admin-field">
                <span>Chinese characters</span>
                <textarea
                  className="admin-chinese-input"
                  lang="zh-Hant"
                  rows={2}
                  value={form.chinese}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, chinese: event.target.value }))
                  }
                  placeholder="算盤 算盤子 — blank means this entry has no Chinese"
                />
                <small>
                  Correct the OCR against the scan. Blank clears it; “Discard
                  edits” restores the extracted text.
                </small>
              </label>

              <label className="admin-field">
                <span>Gloss / romanization</span>
                <textarea
                  rows={5}
                  value={form.body}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, body: event.target.value }))
                  }
                />
              </label>

              <label className="admin-verify">
                <input
                  type="checkbox"
                  checked={formVerified}
                  onChange={(event) => setFormVerified(event.target.checked)}
                />
                <span>
                  Verified — I checked this entry against the original scan
                </span>
              </label>

              <p className="admin-save-status" aria-live="polite">
                {saveState === "saving" ? "Saving…" : null}
                {saveState === "saved" ? "Saved ✓" : null}
                {saveState === "error" ? `Error: ${saveError}` : null}
                {saveState === "idle" && dirty ? "Unsaved changes" : null}
              </p>

              <div className="admin-actions">
                <button
                  type="button"
                  className="admin-save admin-save-primary"
                  onClick={() => save({ verify: true })}
                  disabled={readOnly || saveState === "saving"}
                >
                  Save &amp; verify →
                </button>
                <button
                  type="button"
                  className="admin-save"
                  onClick={() => save()}
                  disabled={readOnly || saveState === "saving"}
                >
                  Save
                </button>
                <button
                  type="button"
                  className="admin-nav"
                  onClick={() => advance(-1)}
                  disabled={queue.length === 0}
                >
                  ← Previous
                </button>
                <button
                  type="button"
                  className="admin-nav admin-nav-forward"
                  onClick={() => advance(1)}
                  disabled={queue.length === 0}
                >
                  Next / skip →
                </button>
              </div>

              <div className="admin-editor-foot">
                {selectedEdit && Object.keys(selectedEdit).length > 0 ? (
                  <button
                    type="button"
                    className="admin-discard"
                    onClick={discardEdits}
                    disabled={readOnly || saveState === "saving"}
                  >
                    Discard my edits for this entry
                  </button>
                ) : (
                  <span className="admin-editor-note">
                    Showing extracted text — no manual edits yet.
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="admin-placeholder">
              <h2>Pick an entry to review</h2>
              <p>
                Choose one from the queue to compare it with the{" "}
                <a
                  href="https://archive.org/details/cu31924023550878"
                  target="_blank"
                  rel="noreferrer"
                >
                  original scan
                </a>
                , fix any OCR mistakes, and mark it verified. Your changes are
                saved into <code>content/edits.json</code> — commit that file to
                version them.
              </p>
              <p className="admin-placeholder-meta">
                {queue.length.toLocaleString()} entries in the current queue
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
