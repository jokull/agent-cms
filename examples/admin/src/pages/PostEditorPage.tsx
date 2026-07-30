/**
 * Record editor. Exercises byId, the dry-run `validateUpdate` procedure as
 * live form validation (ADR 0005's claim under test), the DAST editor for the
 * structured_text field, and a sidebar over syncState / links / versions /
 * scheduling.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, CmsShell } from "../client.js";
import type { PickerRow, Post, PostContentEnvelope, UpdatePost } from "../cms/contract.js";
import { ContentField } from "../components/ContentField.js";
import { BoolInput, Field, RefChip, TextInput } from "../components/Fields.js";
import { RecordPicker } from "../components/RecordPicker.js";
import type { PostBlock } from "../components/PostBlockView.js";
import { describeError, issuesByField, issuesOf, type FieldIssue } from "../lib/errors.js";
import { mediaId } from "../lib/presentation.js";
import { navigate } from "../router.js";

const VALIDATE_DEBOUNCE_MS = 350;

/**
 * The write shape wants `Record<string, Record<string, unknown>>` while the
 * read envelope is a typed union of block interfaces. An interface is not
 * assignable to `Record<string, unknown>` (no index signature), and the repo
 * bans `as`, so the payloads are rebuilt through Object.entries. FRICTION.md #8.
 */
function toWriteBlocks(blocks: Record<string, PostBlock>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(blocks).map(([id, block]) => [id, Object.fromEntries(Object.entries(block))]),
  );
}

function draftFrom(record: Post): UpdatePost {
  return {
    title: record.title,
    ...(record.slug === null ? {} : { slug: record.slug }),
    ...(record.excerpt === null ? {} : { excerpt: record.excerpt }),
    ...(record.cover_image === null ? {} : { cover_image: record.cover_image }),
    ...(record.author === null ? {} : { author: record.author }),
    ...(record.category === null ? {} : { category: record.category }),
    ...(record.related_posts === null ? {} : { related_posts: record.related_posts }),
    ...(record.published_date === null ? {} : { published_date: record.published_date }),
    ...(record.seo_field === null ? {} : { seo_field: record.seo_field }),
    ...(record.reading_time === null ? {} : { reading_time: record.reading_time }),
    ...(record.featured === null ? {} : { featured: record.featured }),
  };
}

export function PostEditorPage({ id }: { readonly id: string }) {
  const record = CmsShell.useQuery(client.cms.post.byId, { id });

  if (record.state === "pending") return <p>Loading…</p>;
  if (record.state === "failure") return <p role="alert">{describeError(record.error)}</p>;
  // Remount the whole form when the record identity changes — the editor hook
  // does not take a reactive `value`. FRICTION.md #11.
  return <PostForm key={record.value.id} record={record.value} recordId={id} />;
}

function PostForm({ record, recordId }: { readonly record: Post; readonly recordId: string }) {
  const [draft, setDraft] = useState<UpdatePost>(() => draftFrom(record));
  const [envelope, setEnvelope] = useState<PostContentEnvelope | null>(record.content);
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [validateMs, setValidateMs] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | "author" | "category" | "related">(null);

  const update = CmsShell.useMutation(client.cms.post.update);
  const publish = CmsShell.useMutation(client.cms.post.publish);
  const unpublish = CmsShell.useMutation(client.cms.post.unpublish);

  const patch = (next: Partial<UpdatePost>) => setDraft((prev) => ({ ...prev, ...next }));
  /**
   * Clearing a field means DELETING the key, not setting `undefined`: the
   * generated inputs are `?: T`, not `?: T | undefined`, and there is no null
   * on the wire at all — so "clear this field" is not expressible. This only
   * stops sending the field. FRICTION.md #5.
   */
  const clear = (key: keyof UpdatePost) =>
    setDraft((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const writeData = useMemo<UpdatePost>(
    () => ({
      ...draft,
      ...(envelope
        ? { content: { value: envelope.value, blocks: toWriteBlocks(envelope.blocks) } }
        : {}),
    }),
    [draft, envelope],
  );

  // --- live validation via the dry-run procedure (ADR 0005) -----------------
  const writeRef = useRef(writeData);
  writeRef.current = writeData;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      const started = performance.now();
      const result = await client.cms.post.validateUpdate({ id: recordId, data: writeRef.current });
      if (cancelled) return;
      setValidateMs(Math.round(performance.now() - started));
      setIssues(result.ok ? [] : issuesOf(result.error));
    }, VALIDATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [writeData, recordId]);

  const byField = issuesByField(issues);
  const at = (field: string): readonly FieldIssue[] => byField.get(field) ?? [];
  const formLevel = byField.get("") ?? [];

  const save = async () => {
    const result = await update.mutate({ id: recordId, data: writeData });
    if (result.ok) {
      setNotice(`saved · status ${result.value.status}`);
      setIssues([]);
      return;
    }
    setIssues(issuesOf(result.error));
    setNotice(describeError(result.error));
  };

  const searchAuthors = useCallback(async (q: string): Promise<readonly PickerRow[]> => {
    const result = await client.cms.author.search({ q });
    return result.ok ? result.value : [];
  }, []);
  const searchCategories = useCallback(async (q: string): Promise<readonly PickerRow[]> => {
    const result = await client.cms.category.search({ q });
    return result.ok ? result.value : [];
  }, []);
  const searchPosts = useCallback(async (q: string): Promise<readonly PickerRow[]> => {
    const result = await client.cms.post.search({ q });
    return result.ok ? result.value : [];
  }, []);

  return (
    <section className="editor">
      <div className="editor__main">
        <div className="page__head">
          <h1>{draft.title || record.id}</h1>
          <button type="button" className="link" onClick={() => navigate("/posts")}>
            ← all posts
          </button>
        </div>

        {notice && (
          <p className="notice" role="status">
            {notice}
            <button type="button" onClick={() => setNotice(null)}>
              dismiss
            </button>
          </p>
        )}
        {formLevel.map((issue, index) => (
          <p key={index} className="notice notice--bad" role="alert">
            {issue.message}
          </p>
        ))}

        <Field label="Title" issues={at("title")}>
          <TextInput value={draft.title ?? ""} onChange={(title) => patch({ title })} />
        </Field>

        <Field label="Slug" issues={at("slug")}>
          <TextInput value={draft.slug ?? ""} onChange={(slug) => patch({ slug })} />
        </Field>

        <Field label="Excerpt" issues={at("excerpt")}>
          <TextInput multiline value={draft.excerpt ?? ""} onChange={(excerpt) => patch({ excerpt })} />
        </Field>

        <Field label="Cover image (asset id)" issues={at("cover_image")} hint="No asset URL exists on the RPC surface — FRICTION.md #3">
          <TextInput
            value={mediaId(draft.cover_image) ?? ""}
            onChange={(next) => (next.length === 0 ? clear("cover_image") : patch({ cover_image: next }))}
          />
        </Field>

        <Field label="Author" issues={at("author")}>
          <RefChip
            id={draft.author ?? null}
            label={draft.author ?? null}
            onPick={() => setPicker("author")}
            onClear={() => clear("author")}
          />
        </Field>

        <Field label="Category" issues={at("category")}>
          <RefChip
            id={draft.category ?? null}
            label={draft.category ?? null}
            onPick={() => setPicker("category")}
            onClear={() => clear("category")}
          />
        </Field>

        <Field label="Related posts" issues={at("related_posts")}>
          <div className="chips">
            {(draft.related_posts ?? []).map((relatedId) => (
              <span key={relatedId} className="chip">
                {relatedId}
                <button
                  type="button"
                  onClick={() =>
                    patch({
                      related_posts: (draft.related_posts ?? []).filter((one) => one !== relatedId),
                    })
                  }
                >
                  ×
                </button>
              </span>
            ))}
            <button type="button" onClick={() => setPicker("related")}>
              add
            </button>
          </div>
        </Field>

        <Field label="Published date" issues={at("published_date")}>
          <TextInput
            type="date"
            value={draft.published_date ?? ""}
            onChange={(published_date) =>
              published_date.length === 0 ? clear("published_date") : patch({ published_date })
            }
          />
        </Field>

        <Field label="Reading time" issues={at("reading_time")}>
          <TextInput
            type="number"
            value={draft.reading_time === undefined ? "" : String(draft.reading_time)}
            onChange={(next) =>
              next.length === 0 ? clear("reading_time") : patch({ reading_time: Number(next) })
            }
          />
        </Field>

        <Field label="Featured" issues={at("featured")}>
          <BoolInput value={draft.featured ?? false} onChange={(featured) => patch({ featured })} />
        </Field>

        <Field label="SEO" issues={at("seo_field")}>
          <div className="stack">
            <TextInput
              value={draft.seo_field?.title ?? ""}
              onChange={(title) => patch({ seo_field: { ...draft.seo_field, title } })}
            />
            <TextInput
              multiline
              value={draft.seo_field?.description ?? ""}
              onChange={(description) => patch({ seo_field: { ...draft.seo_field, description } })}
            />
          </div>
        </Field>

        <Field label="Content (structured_text)" issues={at("content")}>
          <ContentField initial={record.content} onChange={setEnvelope} />
        </Field>

        <div className="actions">
          <button type="button" onClick={() => void save()} disabled={update.state === "pending"}>
            Save
          </button>
          <button
            type="button"
            onClick={async () => {
              const result = await publish.mutate({ id: recordId });
              setNotice(result.ok ? `published` : describeError(result.error));
            }}
          >
            Publish
          </button>
          <button
            type="button"
            onClick={async () => {
              const result = await unpublish.mutate({ id: recordId });
              setNotice(result.ok ? `unpublished` : describeError(result.error));
            }}
          >
            Unpublish
          </button>
          <span className="muted">
            {issues.length === 0 ? "valid" : `${issues.length} issue(s)`}
            {validateMs !== null && ` · validate ${validateMs}ms`}
          </span>
        </div>
      </div>

      <Sidebar recordId={recordId} onNotice={setNotice} />

      {picker === "author" && (
        <RecordPicker
          title="Pick an author"
          search={searchAuthors}
          onPick={(row) => {
            patch({ author: row.id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "category" && (
        <RecordPicker
          title="Pick a category"
          search={searchCategories}
          onPick={(row) => {
            patch({ category: row.id });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "related" && (
        <RecordPicker
          title="Add a related post"
          search={searchPosts}
          onPick={(row) => {
            patch({ related_posts: [...(draft.related_posts ?? []), row.id] });
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </section>
  );
}

function Sidebar({
  recordId,
  onNotice,
}: {
  readonly recordId: string;
  readonly onNotice: (message: string) => void;
}) {
  const sync = CmsShell.useQuery(client.cms.post.syncState, { id: recordId });
  const links = CmsShell.useQuery(client.cms.post.links, { id: recordId });
  const versions = CmsShell.useQuery(client.cms.post.versions.list, { id: recordId });
  const schedulePublish = CmsShell.useMutation(client.cms.post.schedulePublish);
  const clearSchedule = CmsShell.useMutation(client.cms.post.clearSchedule);
  const restore = CmsShell.useMutation(client.cms.post.versions.restore);
  const [at, setAt] = useState("");

  return (
    <aside className="sidebar">
      <section>
        <h2>Status</h2>
        {sync.state === "success" ? (
          <dl>
            <dt>status</dt>
            <dd>{sync.value.status ?? "—"}</dd>
            <dt>published</dt>
            <dd>{sync.value.publishedAt ?? "—"}</dd>
            <dt>scheduled publish</dt>
            <dd>{sync.value.scheduledPublishAt ?? "—"}</dd>
            <dt>changed fields</dt>
            <dd>
              {sync.value.changedFields.length === 0 ? "none" : sync.value.changedFields.join(", ")}
            </dd>
          </dl>
        ) : (
          <p className="muted">…</p>
        )}
      </section>

      <section>
        <h2>Schedule</h2>
        <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} />
        <button
          type="button"
          disabled={at.length === 0}
          onClick={async () => {
            const result = await schedulePublish.mutate({ id: recordId, at: new Date(at).toISOString() });
            onNotice(result.ok ? "scheduled" : describeError(result.error));
          }}
        >
          Schedule publish
        </button>
        <button
          type="button"
          onClick={async () => {
            const result = await clearSchedule.mutate({ id: recordId });
            onNotice(result.ok ? "schedule cleared" : describeError(result.error));
          }}
        >
          Clear
        </button>
      </section>

      <section>
        <h2>Backlinks</h2>
        {links.state === "success" ? (
          links.value.length === 0 ? (
            <p className="muted">none</p>
          ) : (
            <ul>
              {links.value.map((backlink, index) => (
                <li key={index}>
                  {backlink.modelApiKey}.{backlink.fieldApiKey} →{" "}
                  <button type="button" className="link" onClick={() => navigate(`/posts/${backlink.recordId}`)}>
                    {backlink.recordId}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="muted">…</p>
        )}
      </section>

      <section>
        <h2>Versions</h2>
        {versions.state === "success" ? (
          <ul className="versions">
            {versions.value.slice(0, 10).map((version) => (
              <li key={version.id}>
                <span>
                  #{version.version_number} {version.action} · {version.actor_label ?? "system"}
                </span>
                <button
                  type="button"
                  onClick={async () => {
                    const result = await restore.mutate({ id: recordId, versionId: version.id });
                    onNotice(result.ok ? `restored #${version.version_number}` : describeError(result.error));
                  }}
                >
                  restore
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">…</p>
        )}
      </section>
    </aside>
  );
}
