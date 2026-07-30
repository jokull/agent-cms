/**
 * Media. `assets.list` grid, `assets.update` metadata, `assets.usages`, and
 * `assets.delete` demonstrating the reference-conflict guard + force.
 */
import { useState } from "react";
import { client, CmsShell } from "../client.js";
import type { AssetRecord, AssetUsage } from "../cms/contract.js";
import { cmsErrors } from "@agent-cms/codegen/errors";
import { describeError } from "../lib/errors.js";
import { Preview } from "../components/Thumb.js";

const PAGE_SIZE = 24;

export function MediaPage() {
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const list = CmsShell.useQuery(client.cms.assets.list, {
    ...(q.trim().length > 0 ? { q: q.trim() } : {}),
    page: { limit: PAGE_SIZE, offset },
  });

  const assets = list.state === "success" ? list.value.assets : [];
  const total = list.state === "success" ? list.value.total : 0;

  return (
    <section className="page">
      <div className="page__head">
        <h1>Media</h1>
        <input
          type="search"
          placeholder="filename contains…"
          value={q}
          onChange={(event) => {
            setQ(event.target.value);
            setOffset(0);
          }}
        />
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}
      {list.state === "failure" && <p role="alert">{describeError(list.error)}</p>}

      <ul className="grid">
        {assets.map((asset) => (
          <li key={asset.id}>
            <button type="button" className="tile" onClick={() => setSelected(asset)}>
              <Preview src={asset.url} alt={asset.alt ?? asset.filename} width={300} />
              <span className="tile__name">{asset.filename}</span>
              <span className="muted">
                {asset.width ?? "?"}×{asset.height ?? "?"} · {Math.round(asset.size / 1024)}kb
              </span>
            </button>
          </li>
        ))}
      </ul>

      <div className="pager">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          ← prev
        </button>
        <span>
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
        </span>
        <button type="button" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
          next →
        </button>
      </div>

      {selected && (
        <AssetPanel
          asset={selected}
          onClose={() => setSelected(null)}
          onNotice={(message) => setNotice(message)}
        />
      )}
    </section>
  );
}

function AssetPanel({
  asset,
  onClose,
  onNotice,
}: {
  readonly asset: AssetRecord;
  readonly onClose: () => void;
  readonly onNotice: (message: string) => void;
}) {
  const [alt, setAlt] = useState(asset.alt ?? "");
  const [title, setTitle] = useState(asset.title ?? "");
  const [blockers, setBlockers] = useState<readonly string[] | null>(null);

  const usages = CmsShell.useQuery(client.cms.assets.usages, { id: asset.id });
  const update = CmsShell.useMutation(client.cms.assets.update);
  const remove = CmsShell.useMutation(client.cms.assets.delete);

  const doDelete = async (force: boolean) => {
    const result = await remove.mutate({ id: asset.id, force });
    if (result.ok) {
      onNotice(`deleted ${asset.filename}`);
      onClose();
      return;
    }
    // The 409 guard: reference-conflict carries the blocking references.
    if (cmsErrors.referenceConflict.is(result.error)) {
      setBlockers(result.error.data.references);
    }
    onNotice(describeError(result.error));
  };

  return (
    <div className="modal" role="dialog" aria-label={asset.filename}>
      <div className="modal__panel">
        <header className="modal__head">
          <strong>{asset.filename}</strong>
          <button type="button" onClick={onClose}>
            ×
          </button>
        </header>

        <Preview src={asset.url} alt={asset.alt ?? asset.filename} width={640} />
        <p className="muted">
          <a href={asset.url} target="_blank" rel="noreferrer">{asset.url}</a>
        </p>

        <label className="field__label">Alt</label>
        <input value={alt} onChange={(event) => setAlt(event.target.value)} />
        <label className="field__label">Title</label>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />

        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              const result = await update.mutate({ id: asset.id, data: { alt, title } });
              onNotice(result.ok ? "metadata saved" : describeError(result.error));
            }}
          >
            Save metadata
          </button>
          <button type="button" onClick={() => void doDelete(false)}>
            Delete
          </button>
          {blockers && (
            <button type="button" onClick={() => void doDelete(true)}>
              Force delete ({blockers.length} refs)
            </button>
          )}
        </div>

        <h3>Usages</h3>
        {usages.state === "success" ? (
          usages.value.length === 0 ? (
            <p className="muted">unused</p>
          ) : (
            <ul>
              {usages.value.map((usage: AssetUsage, index: number) => (
                <li key={index}>
                  {usage.modelApiKey}.{usage.fieldApiKey} → {usage.recordId}
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="muted">…</p>
        )}
      </div>
    </div>
  );
}
