/**
 * Host toolbar, built only from `handle.commands` + `useDastEditorState`.
 * Lifted from examples/editor and extended with block insertion and the
 * record-link/inline-record seams.
 */
import type { DastCommands, DastEditorSnapshot, DefaultMark, HeadingNode } from "@agent-cms/editor-react";

const MARKS: ReadonlyArray<{ mark: DefaultMark; label: string }> = [
  { mark: "strong", label: "B" },
  { mark: "emphasis", label: "I" },
  { mark: "underline", label: "U" },
  { mark: "strikethrough", label: "S" },
  { mark: "code", label: "</>" },
  { mark: "highlight", label: "H" },
];

const HEADINGS: ReadonlyArray<HeadingNode["level"]> = [1, 2, 3];

type BlockChoice = "paragraph" | "heading1" | "heading2" | "heading3" | "codeBlock";

function isBlockChoice(value: string): value is BlockChoice {
  return (
    value === "paragraph" ||
    value === "heading1" ||
    value === "heading2" ||
    value === "heading3" ||
    value === "codeBlock"
  );
}

export interface EditorToolbarProps {
  readonly commands: DastCommands;
  readonly snapshot: DastEditorSnapshot | null;
  readonly onInsertBlock: (type: "hero_section" | "code_block" | "image_gallery") => void;
  readonly onLinkRecord: () => void;
  readonly onInlineRecord: () => void;
}

export function EditorToolbar({
  commands,
  snapshot,
  onInsertBlock,
  onLinkRecord,
  onInlineRecord,
}: EditorToolbarProps) {
  const s = snapshot;

  const applyBlock = (choice: BlockChoice) => {
    if (choice === "paragraph") commands.setParagraph();
    else if (choice === "codeBlock") commands.toggleCodeBlock();
    else if (choice === "heading1") commands.toggleHeading(1);
    else if (choice === "heading2") commands.toggleHeading(2);
    else commands.toggleHeading(3);
  };

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        {MARKS.map(({ mark, label }) => (
          <button
            key={mark}
            type="button"
            className={s?.marks[mark] ? "is-active" : ""}
            onClick={() => commands.toggleMark(mark)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="toolbar__group">
        <select
          value={s && isBlockChoice(s.block) ? s.block : "paragraph"}
          onChange={(event) => {
            if (isBlockChoice(event.target.value)) applyBlock(event.target.value);
          }}
        >
          <option value="paragraph">Paragraph</option>
          {HEADINGS.map((level) => (
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
        <button
          type="button"
          className={s?.activeLink ? "is-active" : ""}
          onClick={() => {
            if (s?.activeLink) {
              commands.unsetLink();
              return;
            }
            const url = window.prompt("Link URL");
            if (url) commands.setLink(url);
          }}
        >
          {s?.activeLink ? "Unlink" : "Link"}
        </button>
        <button type="button" onClick={onLinkRecord} disabled={s?.selectionEmpty !== false}>
          {s?.activeItemLink ? "Re-link record" : "Link record"}
        </button>
        <button type="button" onClick={onInlineRecord}>
          Inline record
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" onClick={() => onInsertBlock("hero_section")}>
          + hero
        </button>
        <button type="button" onClick={() => onInsertBlock("code_block")}>
          + code
        </button>
        <button type="button" onClick={() => onInsertBlock("image_gallery")}>
          + gallery
        </button>
      </div>

      <div className="toolbar__group">
        <button type="button" onClick={() => commands.insertTable(2, 2)}>
          Table
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.addRowAfter()}>
          +Row
        </button>
        <button type="button" disabled={!s?.inTable} onClick={() => commands.deleteRow()}>
          −Row
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
