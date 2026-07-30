import type { DastCommands, DastEditorSnapshot, DefaultMark, HeadingNode } from "@agent-cms/editor-react";

const MARK_BUTTONS: ReadonlyArray<{ mark: DefaultMark; label: string }> = [
  { mark: "strong", label: "B" },
  { mark: "emphasis", label: "I" },
  { mark: "underline", label: "U" },
  { mark: "strikethrough", label: "S" },
  { mark: "code", label: "</>" },
  { mark: "highlight", label: "H" },
];

const CUSTOM_MARK = "customMark_kbd";

const HEADING_LEVELS: ReadonlyArray<HeadingNode["level"]> = [1, 2, 3];

type BlockChoice = "paragraph" | "heading1" | "heading2" | "heading3" | "codeBlock";

export interface ToolbarProps {
  commands: DastCommands;
  snapshot: DastEditorSnapshot | null;
}

/**
 * Built exclusively from `handle.commands` and the reactive snapshot from
 * `useDastEditorState` — no `handle.editor.chain()` escape hatch anywhere in
 * this file.
 */
export function Toolbar({ commands, snapshot }: ToolbarProps) {
  const s = snapshot;

  const onBlockChange = (choice: BlockChoice) => {
    if (choice === "paragraph") commands.setParagraph();
    else if (choice === "codeBlock") commands.toggleCodeBlock();
    else {
      const level = Number(choice.replace("heading", "")) as HeadingNode["level"];
      commands.toggleHeading(level);
    }
  };

  const onLink = () => {
    if (s?.activeLink) {
      commands.unsetLink();
      return;
    }
    const url = window.prompt("Link URL");
    if (url) commands.setLink(url);
  };

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        {MARK_BUTTONS.map(({ mark, label }) => (
          <button
            key={mark}
            type="button"
            className={s?.marks[mark] ? "is-active" : ""}
            onClick={() => commands.toggleMark(mark)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          className={s?.customMarks.includes(CUSTOM_MARK) ? "is-active" : ""}
          onClick={() => commands.toggleMark(CUSTOM_MARK)}
          title="customMark_kbd"
        >
          kbd
        </button>
      </div>

      <div className="toolbar__group">
        <select
          value={s?.block ?? "paragraph"}
          onChange={(event) => onBlockChange(event.target.value as BlockChoice)}
        >
          <option value="paragraph">Paragraph</option>
          {HEADING_LEVELS.map((level) => (
            <option key={level} value={`heading${level}`}>
              Heading {level}
            </option>
          ))}
          <option value="codeBlock">Code block</option>
        </select>
      </div>

      <div className="toolbar__group">
        <button
          type="button"
          className={s?.listStyle === "bulleted" ? "is-active" : ""}
          onClick={() => commands.toggleList("bulleted")}
        >
          • List
        </button>
        <button
          type="button"
          className={s?.listStyle === "numbered" ? "is-active" : ""}
          onClick={() => commands.toggleList("numbered")}
        >
          1. List
        </button>
        <button
          type="button"
          className={s?.inBlockquote ? "is-active" : ""}
          onClick={() => commands.toggleBlockquote()}
        >
          Quote
        </button>
        <button type="button" onClick={() => commands.insertThematicBreak()}>
          HR
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" className={s?.activeLink ? "is-active" : ""} onClick={onLink}>
          {s?.activeLink ? "Unlink" : "Link"}
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" onClick={() => commands.insertTable(2, 2)}>
          Insert table
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.addRowAfter()}>
          +Row
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.deleteRow()}>
          -Row
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.addColumnAfter()}>
          +Col
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.deleteColumn()}>
          -Col
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" disabled={!s?.canUndo} onClick={() => commands.undo()}>
          Undo
        </button>
        <button type="button" disabled={!s?.canRedo} onClick={() => commands.redo()}>
          Redo
        </button>
      </div>
    </div>
  );
}
