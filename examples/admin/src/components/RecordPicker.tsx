/**
 * Host-owned record picker modal. The toolkit ships no picker (ADR 0006:
 * "toolbars, forms, pickers, modals, styling: host-owned"), so this is built
 * on `<model>.search`, which returns presentation rows (id/title/image/status).
 */
import { useEffect, useState } from "react";
import type { PickerRow } from "../cms/contract.js";
import { Thumb } from "./Thumb.js";

export interface RecordPickerProps {
  readonly title: string;
  readonly search: (q: string) => Promise<readonly PickerRow[]>;
  readonly onPick: (row: PickerRow) => void;
  readonly onClose: () => void;
}

export function RecordPicker({ title, search, onPick, onClose }: RecordPickerProps) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<readonly PickerRow[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    const timer = setTimeout(() => {
      void search(q).then((next) => {
        if (!cancelled) {
          setRows(next);
          setBusy(false);
        }
      });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, search]);

  return (
    <div className="modal" role="dialog" aria-label={title}>
      <div className="modal__panel">
        <header className="modal__head">
          <strong>{title}</strong>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </header>
        <input
          autoFocus
          type="search"
          placeholder="search…"
          value={q}
          onChange={(event) => setQ(event.target.value)}
        />
        {busy && <p className="muted">searching…</p>}
        <ul className="picker">
          {rows.map((row) => (
            <li key={row.id}>
              <button type="button" onClick={() => onPick(row)}>
                <Thumb src={row.imageUrl} alt={row.title} size={28} className="picker__thumb" />
                <span className="picker__title">{row.title ?? row.id}</span>
                <span className={`pill pill--${row.status ?? "draft"}`}>{row.status ?? "?"}</span>
              </button>
            </li>
          ))}
          {!busy && rows.length === 0 && <li className="muted">no matches</li>}
        </ul>
      </div>
    </div>
  );
}
