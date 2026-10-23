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
  snippetFor,
  type DictionaryData,
  type Entry,
  type LetterCount,
} from "./lib/dictionary";
import Admin from "./Admin";

const PAGE_SIZE = 120;

interface AppParams {
  q: string;
  letter: string;
  entry: string | null;
  /** `?admin=1` opens the review/edit CMS page instead of the reader. */
  admin?: boolean;
}

function readParams(): AppParams {
  const params = new URLSearchParams(window.location.search);
  const rawLetter = (params.get("letter") ?? "A").toUpperCase();
  return {
    q: params.get("q") ?? "",
    letter: /^[A-Z]$/.test(rawLetter) ? rawLetter : "A",
    entry: params.get("entry"),
    admin: params.get("admin") === "1",
  };
}

function writeUrl(params: AppParams, mode: "push" | "replace" = "replace") {
  const search = new URLSearchParams();
  if (params.q.trim()) search.set("q", params.q.trim());
  search.set("letter", params.letter);
  if (params.entry) search.set("entry", params.entry);
  const url = `${window.location.pathname}?${search.toString()}`;
  window.history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
}

function HighlightedHeadword({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + q.length)}</mark>
      {text.slice(index + q.length)}
    </>
  );
}

function EntryDetail({ entry, onBack }: { entry: Entry; onBack: () => void }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
    };
  }, []);

  async function copyLink() {
    const url = new URL(window.location.href);
    url.searchParams.set("letter", entry.letter);
    url.searchParams.set("entry", entry.id);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <article className="entry" aria-labelledby="entry-headword">
      <button className="detail-back" type="button" onClick={onBack}>
        ← Back to results
      </button>
      <div className="entry-kicker">
        <span className="entry-letter">{entry.letter}</span>
        <span>Page {entry.page}</span>
      </div>
      <h2 id="entry-headword">{entry.headword}</h2>
      <div className="entry-rule" aria-hidden="true">
        <span />
      </div>
      {entry.chinese ? (
        <p className="entry-chinese" lang="zh-Hant">
          {entry.chinese}
        </p>
      ) : null}
      <p className="entry-body">{entry.body}</p>
      <div className="entry-actions">
        <a
          className="source-link"
          href={scanUrl(entry)}
          target="_blank"
          rel="noreferrer"
        >
          View original page <span aria-hidden="true">↗</span>
        </a>
        <button className="copy-button" type="button" onClick={copyLink}>
          {copied ? "Link copied" : "Copy link"}
        </button>
      </div>
      <aside className="caveat">
        <strong>About this text.</strong> This is an automatic transcription of the
        1883 printed page. The Amoy romanization is preserved approximately and
        the Chinese characters are OCR'd from the scanned page image at 300 dpi,
        so recognition errors are possible — check the scan link above to
        verify.
      </aside>
    </article>
  );
}

function EmptyDetail({ total }: { total: number }) {
  return (
    <div className="empty-detail">
      <div className="empty-mark" aria-hidden="true">
        <span>A</span>
        <span>–</span>
        <span>Z</span>
      </div>
      <h2>Browse the dictionary</h2>
      <p>
        Search an English headword, or try an Amoy romanization such as{" "}
        <em>thiaⁿ</em>, <em>tsun</em>, or <em>khi</em>. Choose a letter above to
        read page by page.
      </p>
      <p className="empty-meta">{total.toLocaleString()} entries from the 1883 edition</p>
    </div>
  );
}

export default function App() {
  const [initialParams] = useState<AppParams>(readParams);
  // The admin CMS has its own component tree; this branch is stable for the
  // lifetime of the page, so hook order never changes.
  if (initialParams.admin) return <Admin />;
  const [data, setData] = useState<DictionaryData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState(initialParams.q);
  const [letter, setLetter] = useState(initialParams.letter);
  const [selectedId, setSelectedId] = useState<string | null>(
    initialParams.entry,
  );
  const [visible, setVisible] = useState(PAGE_SIZE);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoSelected = useRef(false);

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
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const onPop = () => {
      const params = readParams();
      setQuery(params.q);
      setLetter(params.letter);
      setSelectedId(params.entry);
      setVisible(PAGE_SIZE);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.key === "/" &&
        !(target instanceof HTMLInputElement) &&
        !(target instanceof HTMLTextAreaElement)
      ) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const index = useMemo(() => (data ? buildIndex(data.entries) : []), [data]);
  const byId = useMemo(() => {
    const map = new Map<string, Entry>();
    for (const entry of data?.entries ?? []) map.set(entry.id, entry);
    return map;
  }, [data]);

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const searchHits = useMemo(
    () => (isSearching ? searchEntries(index, trimmedQuery) : []),
    [index, trimmedQuery, isSearching],
  );
  const browseEntries = useMemo(
    () => (data ? data.entries.filter((entry) => entry.letter === letter) : []),
    [data, letter],
  );
  const results: Entry[] = isSearching
    ? searchHits.map((hit) => hit.entry)
    : browseEntries;

  const selectedEntry = selectedId ? byId.get(selectedId) : undefined;

  const selectEntry = useCallback(
    (entry: Entry, mode: "push" | "replace" = "push") => {
      setSelectedId(entry.id);
      writeUrl({ q: query, letter, entry: entry.id }, mode);
    },
    [query, letter],
  );

  useEffect(() => {
    if (!data || autoSelected.current) return;
    autoSelected.current = true;
    if (selectedId) return;
    if (initialParams.entry) return;
    if (initialParams.q.trim()) return;
    if (!window.matchMedia("(min-width: 960px)").matches) return;
    const first = data.entries.find((entry) => entry.letter === initialParams.letter);
    if (first) {
      setSelectedId(first.id);
      writeUrl(
        { q: "", letter: initialParams.letter, entry: first.id },
        "replace",
      );
    }
  }, [data, initialParams, selectedId]);

  function handleQuery(value: string) {
    setQuery(value);
    setVisible(PAGE_SIZE);
    setSelectedId(null);
    writeUrl({ q: value, letter, entry: null }, "replace");
  }

  function handleLetter(nextLetter: string) {
    setLetter(nextLetter);
    setQuery("");
    setVisible(PAGE_SIZE);
    setSelectedId(null);
    writeUrl({ q: "", letter: nextLetter, entry: null }, "replace");
  }

  function clearSearch() {
    handleQuery("");
    inputRef.current?.focus();
  }

  if (loadError) {
    return (
      <div className="status-screen">
        <p className="status-kicker">English–Amoy Dictionary</p>
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
        <p className="status-kicker">English–Amoy Dictionary</p>
        <h1>Opening the dictionary…</h1>
        <p>1883 · Amoy (Xiamen) Hokkien · Macgowan</p>
      </div>
    );
  }

  const letters: LetterCount[] = data.meta.letters;
  const shown = results.slice(0, visible);
  const remaining = results.length - shown.length;
  const headingLetter = letters.find((item) => item.letter === letter);

  return (
    <div className={`app${selectedEntry ? " has-selection" : ""}`}>
      <div className="page">
        <header className="masthead">
          <div className="masthead-top">
            <span className="eyebrow">Macgowan · 1883</span>
            <span className="edition">Amoy (Xiamen) Hokkien · First digital edition</span>
            <a className="admin-link" href="?admin=1" aria-label="Open the review and edit admin page">
              Admin
            </a>
          </div>
          <h1>
            English–<em>Amoy</em> Dictionary
          </h1>
          <p className="lede">
            A searchable edition of Rev. J. Macgowan&apos;s{" "}
            <cite>English and Chinese Dictionary of the Amoy Dialect</cite>, with
            English headwords, the Amoy romanization, and the Chinese characters
            of the original.
          </p>
          <div className="masthead-meta">
            <span>
              <strong>{data.meta.totalEntries.toLocaleString()}</strong> entries
            </span>
            <span className="dot" aria-hidden="true">·</span>
            <span>598 printed pages</span>
            <span className="dot" aria-hidden="true">·</span>
            <a href={data.meta.source} target="_blank" rel="noreferrer">
              Internet Archive scan ↗
            </a>
          </div>
        </header>

        <div className="toolbar">
          <div className="search-field">
            <svg
              className="search-icon"
              viewBox="0 0 20 20"
              aria-hidden="true"
            >
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4.5 4.5" />
            </svg>
            <input
              ref={inputRef}
              type="search"
              value={query}
              onChange={(event) => handleQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  clearSearch();
                }
              }}
              placeholder="Search English, 汉字, or Amoy romanization"
              aria-label="Search the dictionary"
              autoComplete="off"
              spellCheck={false}
            />
            {query ? (
              <button
                type="button"
                className="clear-search"
                onClick={clearSearch}
                aria-label="Clear search"
              >
                ×
              </button>
            ) : (
              <kbd className="search-hint">/</kbd>
            )}
          </div>

          <div className="alphabet" role="group" aria-label="Browse by letter">
            {letters.map((item) => (
              <button
                key={item.letter}
                type="button"
                className={`letter${!isSearching && item.letter === letter ? " is-active" : ""}`}
                onClick={() => handleLetter(item.letter)}
                aria-pressed={!isSearching && item.letter === letter}
                title={`${item.count.toLocaleString()} entries starting with ${item.letter}`}
              >
                {item.letter}
              </button>
            ))}
          </div>
        </div>

        <main className="workspace">
          <section className="results-pane" aria-label="Dictionary entries">
            <div className="results-head">
              <div>
                {isSearching ? (
                  <>
                    <p className="results-kicker">Search</p>
                    <p className="results-title">
                      {results.length.toLocaleString()}{" "}
                      {results.length === 1 ? "match" : "matches"} for “
                      {trimmedQuery}”
                    </p>
                  </>
                ) : (
                  <>
                    <p className="results-kicker">Browse</p>
                    <p className="results-title">
                      {letter} · {results.length.toLocaleString()} entries
                    </p>
                  </>
                )}
              </div>
              {!isSearching && headingLetter ? (
                <span className="results-range" aria-hidden="true">
                  {letter}
                </span>
              ) : null}
            </div>

            {results.length === 0 ? (
              <div className="empty-results">
                <h3>No entries found</h3>
                <p>
                  Try a shorter spelling, or search the romanization instead of the
                  English word.
                </p>
                {isSearching ? (
                  <button type="button" onClick={clearSearch}>
                    Clear search
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <ol className="results-list">
                  {shown.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        className={`result${entry.id === selectedId ? " is-selected" : ""}`}
                        onClick={() => selectEntry(entry)}
                        aria-current={entry.id === selectedId ? "true" : undefined}
                      >
                        <span className="result-main">
                          <span className="result-headword">
                            <HighlightedHeadword
                              text={entry.headword}
                              query={isSearching ? trimmedQuery : ""}
                            />
                          </span>
                          <span className="result-snippet">
                            {snippetFor(entry, trimmedQuery)}
                          </span>
                          {entry.chinese && !trimmedQuery.match(/[\u3400-\u9fff]/) ? (
                            <span className="result-chinese" lang="zh-Hant">
                              {entry.chinese}
                            </span>
                          ) : null}
                        </span>
                        <span className="result-page">{entry.page}</span>
                      </button>
                    </li>
                  ))}
                </ol>
                {remaining > 0 ? (
                  <button
                    type="button"
                    className="show-more"
                    onClick={() => setVisible((count) => count + PAGE_SIZE)}
                  >
                    Show {Math.min(PAGE_SIZE, remaining)} more
                    <span>{remaining.toLocaleString()} remaining</span>
                  </button>
                ) : (
                  <p className="list-end">
                    End of {results.length.toLocaleString()}{" "}
                    {isSearching ? "matches" : `entries for ${letter}`}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="detail-pane" aria-label="Entry">
            {selectedEntry ? (
              <EntryDetail
                key={selectedEntry.id}
                entry={selectedEntry}
                onBack={() => {
                  setSelectedId(null);
                  writeUrl({ q: query, letter, entry: null }, "replace");
                }}
              />
            ) : (
              <EmptyDetail total={data.meta.totalEntries} />
            )}
          </section>
        </main>

        <footer className="footer">
          <div className="footer-main">
            <p>
              <strong>Source.</strong>{" "}
              <a href={data.meta.source} target="_blank" rel="noreferrer">
                English and Chinese Dictionary of the Amoy Dialect
              </a>{" "}
              (1883), Rev. J. Macgowan. Cornell University Library copy,
              digitized by the Internet Archive.
            </p>
            <p className="footer-small">
              An independent prototype. Not affiliated with the Internet Archive
              or Cornell University.
            </p>
          </div>
          <details className="about">
            <summary>About this digital edition</summary>
            <div className="about-body">
              <p>
                The dictionary was built from the text layer of the scanned PDF.
                English headwords, glosses, and the Amoy romanization were
                extracted automatically and lightly cleaned; the text is not
                hand-corrected, so OCR errors and stray characters remain.
              </p>
              <p>
                The original&apos;s Chinese characters are printed as images in the
                PDF and carry no usable text, so they were OCR'd from the page
                images (300 dpi, line-by-line recognition) and attached to their
                entries. Being machine-read, they can contain misrecognised
                characters; every entry links to its page in the Internet
                Archive scan, where the printed Chinese can be checked.
              </p>
              <p>
                Macgowan&apos;s romanization is kept close to the printed source
                and is not converted to modern Pe̍h-ōe-jī. Superscript tone marks
                are omitted where the text layer garbled them.
              </p>
            </div>
          </details>
        </footer>
      </div>
    </div>
  );
}
