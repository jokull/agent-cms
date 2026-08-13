import { useEffect, useState } from "react";
import { client } from "./client.js";
import type { Post, PostContentEnvelope } from "./cms/contract.js";
import { DastEditor } from "./editor/DastEditor.jsx";

type SaveState = "idle" | "saving" | "saved" | "error";

export function App() {
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PostContentEnvelope | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.cms.post.list({});
      if (cancelled) return;
      if (result.isOk()) {
        setPosts([...result.value.records]);
        const first = result.value.records[0];
        if (first) select(first);
      } else {
        setLoadError("Failed to load posts.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function select(post: Post) {
    setSelectedId(post.id);
    setDraft(post.content ?? null);
    setSaveState("idle");
  }

  async function createPost() {
    const n = (posts?.length ?? 0) + 1;
    const result = await client.cms.post.create({ data: { title: `New post ${n}` } });
    if (result.isOk()) {
      setPosts((prev) => [...(prev ?? []), result.value]);
      select(result.value);
    }
  }

  async function save() {
    if (!selectedId || !draft) return;
    setSaveState("saving");
    const result = await client.cms.post.update({ id: selectedId, data: { content: draft } });
    if (result.isOk()) {
      setPosts((prev) => (prev ?? []).map((p) => (p.id === selectedId ? result.value : p)));
      setSaveState("saved");
    } else {
      setSaveState("error");
    }
  }

  const selected = posts?.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="sidebar__title">blocks-editor</h1>
        <button type="button" className="sidebar__new" onClick={createPost}>
          + New post
        </button>
        {posts === null ? (
          <p className="sidebar__muted">Loading…</p>
        ) : (
          posts.map((post) => (
            <button
              type="button"
              key={post.id}
              className={`sidebar__item${post.id === selectedId ? " sidebar__item--active" : ""}`}
              onClick={() => select(post)}
            >
              {post.title}
            </button>
          ))
        )}
      </aside>

      <main className="main">
        {loadError ? <p className="main__error">{loadError}</p> : null}
        {selected ? (
          <>
            <div className="main__header">
              <h2 className="main__title">{selected.title}</h2>
              <div className="main__actions">
                <span className={`save save--${saveState}`}>
                  {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : saveState === "error" ? "Save failed" : ""}
                </span>
                <button type="button" className="main__save" onClick={save} disabled={saveState === "saving"}>
                  Save
                </button>
              </div>
            </div>
            <DastEditor key={selected.id} initial={selected.content} onChange={setDraft} />
          </>
        ) : (
          <p className="main__empty">Create a post to start editing.</p>
        )}
      </main>
    </div>
  );
}
