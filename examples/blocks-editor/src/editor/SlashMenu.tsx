/**
 * The slash-command popup. Owns filtering, keyboard navigation, and the
 * commit/close (delete the `/query` text, then run the command). It is a pure
 * host component — the plugin in slash.ts only publishes the query.
 */
import { useEffect, useMemo, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import type { DastCommands } from "@agent-cms/editor-react";
import { slashKey, type SlashCommand } from "./slash.js";

interface SlashMenuProps {
  readonly editor: Editor | null;
  readonly commands: DastCommands;
  readonly items: readonly SlashCommand[];
}

export function SlashMenu({ editor, commands, items }: SlashMenuProps) {
  const slash = useEditorState({
    editor,
    selector: ({ editor: current }) =>
      current && !current.isDestroyed ? (slashKey.getState(current.state) ?? null) : null,
  });

  const filtered = useMemo(() => {
    if (!slash) return [];
    const q = slash.query.trim().toLowerCase();
    return items.filter((item) => {
      if (!q) return true;
      const hay = `${item.id} ${item.title} ${item.description ?? ""} ${(item.keywords ?? []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [slash, items]);

  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [slash?.query]);

  const position = useMemo(() => {
    if (!slash || !editor) return { top: 0, left: 0 };
    const coords = editor.view.coordsAtPos(slash.from);
    return { top: coords.bottom + 6, left: coords.left };
  }, [slash, editor]);

  // Deleting the `/query` range makes the plugin's detectSlash return null, so
  // the menu closes; commit additionally runs the chosen command on the now-
  // empty textblock.
  const close = useMemo(
    () => () => {
      if (!slash || !editor) return;
      editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
    },
    [slash, editor],
  );

  const commit = useMemo(
    () => (item: SlashCommand) => {
      if (!slash || !editor) return;
      editor.chain().focus().deleteRange({ from: slash.from, to: slash.to }).run();
      item.run(commands);
    },
    [slash, editor, commands],
  );

  useEffect(() => {
    if (!slash) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setSelected((s) => (filtered.length ? (s + 1) % filtered.length : 0));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setSelected((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0));
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const item = filtered[selected];
        if (item) commit(item);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [slash, filtered, selected, commit, close]);

  if (!slash || filtered.length === 0) return null;

  return (
    <div className="slash" style={{ top: position.top, left: position.left }}>
      <div className="slash__label">{slash.query ? `Results for “${slash.query}”` : "Insert"}</div>
      {filtered.map((item, i) => (
        <button
          type="button"
          key={item.id}
          className={`slash__item${i === selected ? " slash__item--selected" : ""}`}
          onMouseEnter={() => setSelected(i)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => commit(item)}
        >
          <span className="slash__title">{item.title}</span>
          {item.description ? <span className="slash__desc">{item.description}</span> : null}
        </button>
      ))}
    </div>
  );
}
