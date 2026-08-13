/**
 * RecordSelect — the DatoCMS-style link-field picker, host-owned. Three modes:
 *
 *   dropdown  — a typeahead list fed by `<model>.search({ q })`.
 *   library   — a "From Library" dialog: `<model>.list({ filter, page })` in a
 *               table keyed on the model's presentation (default title,
 *               default thumbnail, system `status`/`updatedAt`), with a name
 *               filter and simple pagination.
 *   create    — an inline form that calls `<model>.create`, then selects the
 *               new record.
 *
 * This demo's only link field is hero_section.author → author, so it is typed
 * to `Author` + `AUTHOR_PRESENTATION`. The shape is deliberately generic: the
 * only model-specific bits are the three client calls and the presentation
 * descriptor at the top.
 */
import { useEffect, useRef, useState } from "react";
import {
  AUTHOR_PRESENTATION,
  presentRecord,
  type Author,
  type PickerRow,
} from "../cms/contract.js";
import { client } from "../client.js";

type Mode = "closed" | "dropdown" | "library" | "create";

export interface RecordSelectProps {
  /** Current selected record id (the link field value), or null when unset. */
  readonly value: string | null;
  /** Called with the new id (or null to clear). */
  readonly onChange: (id: string | null) => void;
  /** Field label for headings and the create form. */
  readonly title: string;
}

const PAGE_SIZE = 8;

/** A small thumbnail cell: the row's default image, or a placeholder dot. */
function Thumb({ src, alt }: { readonly src: string | null; readonly alt: string | null }) {
  if (src === null) return <span className="recsel__thumb recsel__thumb--empty" aria-hidden="true" />;
  return <img className="recsel__thumb" src={src} alt={alt ?? ""} loading="lazy" />;
}

function formatDate(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
}

export function RecordSelect({ value, onChange, title }: RecordSelectProps) {
  const [mode, setMode] = useState<Mode>("closed");

  // The current selection's presentation (title + thumb + status + updatedAt).
  const [selected, setSelected] = useState<PickerRow | null>(null);
  // The id we last resolved from `value` — avoids a redundant byId after a pick.
  const resolvedRef = useRef<string | null>(null);

  // dropdown state
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<readonly PickerRow[]>([]);
  const [busy, setBusy] = useState(false);

  // library state
  const [filter, setFilter] = useState("");
  const [libraryRows, setLibraryRows] = useState<readonly PickerRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  // create state
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Resolve the selected record from `value` (the block payload only carries
  // the id; the name lives on the author record).
  useEffect(() => {
    let cancelled = false;
    if (value === null) {
      resolvedRef.current = null;
      setSelected(null);
      return;
    }
    if (resolvedRef.current === value) return;
    resolvedRef.current = value;
    void (async () => {
      const result = await client.cms.author.byId({ id: value });
      if (cancelled) return;
      if (result.isOk()) setSelected(presentRecord(result.value, AUTHOR_PRESENTATION));
    })();
    return () => {
      cancelled = true;
    };
  }, [value]);

  // dropdown: debounced typeahead.
  useEffect(() => {
    if (mode !== "dropdown") return;
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(async () => {
      const result = await client.cms.author.search({ q });
      if (cancelled) return;
      setRows(result.isOk() ? result.value : []);
      setBusy(false);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, mode]);

  // library: list with a name filter, paged.
  useEffect(() => {
    if (mode !== "library") return;
    let cancelled = false;
    setBusy(true);
    void (async () => {
      const result = await client.cms.author.list({
        ...(filter.length > 0 ? { filter: { name: { matches: filter } } } : {}),
        orderBy: ["name_ASC"],
        page: { limit: PAGE_SIZE, offset },
      });
      if (cancelled) return;
      if (result.isOk()) {
        setLibraryRows(result.value.records.map((record) => presentRecord(record, AUTHOR_PRESENTATION)));
        setTotal(result.value.total);
      }
      setBusy(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, filter, offset]);

  const pick = (row: PickerRow) => {
    resolvedRef.current = row.id;
    setSelected(row);
    onChange(row.id);
    setMode("closed");
    setQ("");
    setFilter("");
    setOffset(0);
  };

  const clear = () => {
    resolvedRef.current = null;
    setSelected(null);
    onChange(null);
    setMode("closed");
  };

  const create = async () => {
    setError(null);
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required");
      return;
    }
    const result = await client.cms.author.create({
      data: { name: trimmed, ...(role.trim().length > 0 ? { role: role.trim() } : {}) },
    });
    if (result.isOk()) {
      pick(presentRecord(result.value, AUTHOR_PRESENTATION));
    } else {
      setError("Could not create author");
    }
  };

  const close = () => {
    setMode("closed");
    setQ("");
    setFilter("");
    setOffset(0);
    setError(null);
  };

  return (
    <div className="recsel">
      <div className="recsel__trigger">
        {selected !== null ? (
          <button type="button" className="recsel__value" onClick={() => setMode("dropdown")}>
            <Thumb src={selected.imageUrl} alt={selected.title} />
            <span className="recsel__title">{selected.title ?? selected.id}</span>
            {selected.status !== null && (
              <span className={`pill pill--${selected.status}`}>{selected.status}</span>
            )}
          </button>
        ) : (
          <button type="button" className="recsel__value recsel__value--empty" onClick={() => setMode("dropdown")}>
            Select {title.toLowerCase()}…
          </button>
        )}
        {selected !== null && (
          <button type="button" className="recsel__clear" onClick={clear} aria-label="Clear">
            ×
          </button>
        )}
      </div>

      {mode === "dropdown" && (
        <div className="recsel__panel">
          <input
            autoFocus
            type="search"
            placeholder="Search…"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          {busy ? (
            <p className="muted">searching…</p>
          ) : (
            <ul className="recsel__list">
              {rows.map((row) => (
                <li key={row.id}>
                  <button type="button" onClick={() => pick(row)}>
                    <Thumb src={row.imageUrl} alt={row.title} />
                    <span className="recsel__title">{row.title ?? row.id}</span>
                    {row.status !== null && <span className={`pill pill--${row.status}`}>{row.status}</span>}
                  </button>
                </li>
              ))}
              {rows.length === 0 && <li className="muted">no matches</li>}
            </ul>
          )}
          <div className="recsel__actions">
            <button type="button" onClick={() => setMode("library")}>
              From Library
            </button>
            <button type="button" onClick={() => setMode("create")}>
              Create new
            </button>
          </div>
        </div>
      )}

      {mode === "library" && (
        <div className="modal" role="dialog" aria-label={`${title} library`}>
          <div className="modal__backdrop" onClick={close} />
          <div className="modal__panel">
            <header className="modal__head">
              <strong>{title} library</strong>
              <button type="button" onClick={close}>
                ×
              </button>
            </header>
            <input
              autoFocus
              type="search"
              placeholder="Filter by name…"
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setOffset(0);
              }}
            />
            <table className="recsel__table">
              <thead>
                <tr>
                  <th aria-hidden="true" />
                  <th>Title</th>
                  <th>Status</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {libraryRows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Thumb src={row.imageUrl} alt={row.title} />
                    </td>
                    <td>
                      <button type="button" className="link" onClick={() => pick(row)}>
                        {row.title ?? row.id}
                      </button>
                    </td>
                    <td>{row.status !== null ? <span className={`pill pill--${row.status}`}>{row.status}</span> : "—"}</td>
                    <td className="muted">{formatDate(row.updatedAt)}</td>
                  </tr>
                ))}
                {!busy && libraryRows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="muted">
                      no authors
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <footer className="recsel__foot">
              <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                ‹ prev
              </button>
              <span className="muted">
                {offset + 1}–{offset + libraryRows.length} of {total}
              </span>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                next ›
              </button>
              <button type="button" className="recsel__foot-create" onClick={() => setMode("create")}>
                Create new
              </button>
            </footer>
          </div>
        </div>
      )}

      {mode === "create" && (
        <div className="modal" role="dialog" aria-label={`New ${title}`}>
          <div className="modal__backdrop" onClick={close} />
          <div className="modal__panel">
            <header className="modal__head">
              <strong>New {title}</strong>
              <button type="button" onClick={close}>
                ×
              </button>
            </header>
            <label className="recsel__field">
              Name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
              />
            </label>
            <label className="recsel__field">
              Role
              <input value={role} onChange={(event) => setRole(event.target.value)} />
            </label>
            {error !== null && (
              <p className="notice notice--bad" role="alert">
                {error}
              </p>
            )}
            <footer className="recsel__foot">
              <button type="button" onClick={() => void create()}>
                Create
              </button>
              <button type="button" onClick={() => setMode("dropdown")}>
                Cancel
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
