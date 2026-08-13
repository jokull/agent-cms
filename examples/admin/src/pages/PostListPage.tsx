/**
 * Record list. Exercises `post.list` (filter / orderBy / page / status),
 * bulk publish + delete, row duplicate + delete, and — the "one client, one
 * cache" claim — the HOST's own `host.inventory.list` joined to CMS rows by
 * slug, from the same client.
 */
import { useMemo, useState } from "react";
import { useResultQuery } from "result-rpc/react";
import { client, CmsShell } from "../client.js";
import { POST_PRESENTATION, presentRecord } from "../cms/contract.js";
import type { PostFilter, PostOrderBy, RecordStatus } from "../cms/contract.js";
import { describeError } from "../lib/errors.js";
import { Thumb } from "../components/Thumb.js";
import { navigate } from "../router.js";

const PAGE_SIZE = 10;

type SortColumn = "title" | "_updatedAt" | "_status";

export function PostListPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<RecordStatus | "">("");
  const [sort, setSort] = useState<{ column: SortColumn; dir: "ASC" | "DESC" }>({
    column: "_updatedAt",
    dir: "DESC",
  });
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const filter = useMemo<PostFilter | undefined>(() => {
    if (query.trim().length === 0) return undefined;
    return { title: { matches: { pattern: query.trim(), caseSensitive: false } } };
  }, [query]);

  const orderBy = useMemo<readonly PostOrderBy[]>(() => {
    const literal = `${sort.column}_${sort.dir}`;
    // The orderBy union is a string literal union, so the host has to
    // reconstruct one from (column, direction) state. See FRICTION.md #6.
    const candidates: readonly PostOrderBy[] = [
      "title_ASC",
      "title_DESC",
      "_updatedAt_ASC",
      "_updatedAt_DESC",
      "_status_ASC",
      "_status_DESC",
    ];
    const found = candidates.find((option) => option === literal);
    return found ? [found] : ["_updatedAt_DESC"];
  }, [sort]);

  const list = CmsShell.useQuery(client.cms.post.list, {
    ...(filter ? { filter } : {}),
    orderBy,
    page: { limit: PAGE_SIZE, offset },
    ...(status ? { status } : {}),
  });

  const records = list.state === "success" ? list.value.records : [];
  const total = list.state === "success" ? list.value.total : 0;

  // The host's OWN procedure, same client, same cache — non-CMS inventory data
  // woven into a CMS-driven table.
  const slugs = records.flatMap((record) => (record.slug ? [record.slug] : []));
  const inventory = useResultQuery(client.host.inventory.list, { slugs });
  const inventoryBySlug = new Map(
    inventory.state === "success" ? inventory.value.map((row) => [row.slug, row]) : [],
  );

  const publishMany = CmsShell.useMutation(client.cms.post.publishMany);
  const deleteMany = CmsShell.useMutation(client.cms.post.deleteMany);
  const duplicate = CmsShell.useMutation(client.cms.post.duplicate);
  const remove = CmsShell.useMutation(client.cms.post.delete);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const runBulk = async (kind: "publish" | "delete") => {
    const ids = [...selected];
    if (ids.length === 0) return;
    const result =
      kind === "publish" ? await publishMany.mutateAsync({ ids }) : await deleteMany.mutateAsync({ ids });
    if (result.isErr()) {
      setNotice(describeError(result.error));
      return;
    }
    // Bulk results are DATA, never a failure (ADR 0005) — per-id outcomes.
    const failed = result.value.filter((row) => !row.ok);
    setNotice(
      failed.length === 0
        ? `${kind}: ${result.value.length} ok`
        : `${kind}: ${result.value.length - failed.length} ok, ${failed.length} failed (${failed
            .map((row) => `${row.id}: ${row.error ?? "unknown"}`)
            .join("; ")})`,
    );
    setSelected(new Set());
  };

  const sortBy = (column: SortColumn) =>
    setSort((prev) =>
      prev.column === column
        ? { column, dir: prev.dir === "ASC" ? "DESC" : "ASC" }
        : { column, dir: "ASC" },
    );

  return (
    <section className="page">
      <div className="page__head">
        <h1>Posts</h1>
        <div className="filters">
          <input
            type="search"
            placeholder="title contains…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
          <select
            value={status}
            onChange={(event) => {
              const next = event.target.value;
              setStatus(
                next === "draft" || next === "published" || next === "updated" ? next : "",
              );
              setOffset(0);
            }}
          >
            <option value="">any status</option>
            <option value="draft">draft</option>
            <option value="published">published</option>
            <option value="updated">updated</option>
          </select>
        </div>
      </div>

      {notice && (
        <p className="notice" role="status">
          {notice}
          <button type="button" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </p>
      )}

      <div className="bulkbar">
        <span>{selected.size} selected</span>
        <button type="button" disabled={selected.size === 0} onClick={() => void runBulk("publish")}>
          Publish selected
        </button>
        <button type="button" disabled={selected.size === 0} onClick={() => void runBulk("delete")}>
          Delete selected
        </button>
      </div>

      {list.state === "pending" && <p>Loading…</p>}
      {list.state === "failure" && <p role="alert">{describeError(list.error)}</p>}

      <table className="table">
        <thead>
          <tr>
            <th />
            <th>Preview</th>
            <th>
              <button type="button" onClick={() => sortBy("title")}>
                Title {sort.column === "title" ? (sort.dir === "ASC" ? "▲" : "▼") : ""}
              </button>
            </th>
            <th>
              <button type="button" onClick={() => sortBy("_status")}>
                Status {sort.column === "_status" ? (sort.dir === "ASC" ? "▲" : "▼") : ""}
              </button>
            </th>
            <th>
              <button type="button" onClick={() => sortBy("_updatedAt")}>
                Updated {sort.column === "_updatedAt" ? (sort.dir === "ASC" ? "▲" : "▼") : ""}
              </button>
            </th>
            <th>Seats left (host data)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {records.map((record) => {
            const stock = record.slug ? inventoryBySlug.get(record.slug) : undefined;
            // Generic row rendering: which field is the title and which one is
            // the preview comes from the generated descriptor, not from this
            // file. Same shape the picker rows use. (Was FRICTION.md #2.)
            const row = presentRecord(record, POST_PRESENTATION);
            return (
              <tr key={record.id}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(record.id)}
                    onChange={() => toggle(record.id)}
                  />
                </td>
                <td>
                  {/* The read carries the asset's canonical url — was FRICTION.md #3. */}
                  <Thumb src={row.imageUrl} alt={row.title} />
                </td>
                <td>
                  <button type="button" className="link" onClick={() => navigate(`/posts/${record.id}`)}>
                    {row.title ?? row.id}
                  </button>
                </td>
                <td>
                  <span className={`pill pill--${record.status}`}>{record.status}</span>
                </td>
                <td>{row.updatedAt?.slice(0, 16).replace("T", " ") ?? "—"}</td>
                <td>{stock ? `${stock.seatsLeft} · ¥${stock.priceJpy.toLocaleString()}` : "—"}</td>
                <td className="rowactions">
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await duplicate.mutateAsync({ id: record.id });
                      setNotice(result.isOk() ? `duplicated → ${result.value.id}` : describeError(result.error));
                    }}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const result = await remove.mutateAsync({ id: record.id });
                      setNotice(result.isOk() ? `deleted ${result.value.id}` : describeError(result.error));
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="pager">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          ← prev
        </button>
        <span>
          {total === 0 ? 0 : offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
        </span>
        <button
          type="button"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          next →
        </button>
      </div>
    </section>
  );
}
