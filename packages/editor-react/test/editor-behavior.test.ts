// @vitest-environment jsdom
/**
 * Behavioral tests over a real (headless, jsdom) Tiptap editor: history,
 * the typed command surface, table surgery, custom marks, and HTML paste
 * normalization into the DAST grammar.
 */
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { pmToDast, dastToPm } from "../src/bridge/codec.js";
import type { DastDocument } from "../src/bridge/dast-types.js";
import { createDastExtensions, type DastExtensionOptions } from "../src/bridge/extensions.js";
import { buildCan, buildCommands } from "../src/commands.js";

const editors: Editor[] = [];

function makeEditor(options: DastExtensionOptions = {}, content?: DastDocument) {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createDastExtensions(options),
    enableContentCheck: true,
    ...(content ? { content: dastToPm(content) } : {}),
  });
  editors.push(editor);
  return { editor, commands: buildCommands(editor) };
}

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

function docOf(editor: Editor): DastDocument {
  return pmToDast(editor.getJSON());
}

describe("history", () => {
  it("undoes and redoes an insertion", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("Hello");
    expect(editor.getText()).toContain("Hello");
    expect(editor.can().undo()).toBe(true);
    commands.undo();
    expect(editor.getText()).not.toContain("Hello");
    commands.redo();
    expect(editor.getText()).toContain("Hello");
  });
});

describe("typed commands", () => {
  it("toggles marks", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("word");
    editor.commands.selectAll();
    commands.toggleMark("strong");
    expect(editor.isActive("strong")).toBe(true);
    const dast = docOf(editor);
    const first = dast.document.children[0];
    if (first?.type !== "paragraph") throw new Error("expected paragraph");
    expect(first.children[0]).toMatchObject({ type: "span", marks: ["strong"] });
  });

  it("toggles heading and back to paragraph", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("Title");
    commands.toggleHeading(2);
    expect(docOf(editor).document.children[0]).toMatchObject({ type: "heading", level: 2 });
    commands.toggleHeading(2);
    expect(docOf(editor).document.children[0]?.type).toBe("paragraph");
  });

  it("toggles lists with the DAST style attr", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("item");
    commands.toggleList("numbered");
    const list = docOf(editor).document.children[0];
    expect(list).toMatchObject({ type: "list", style: "numbered" });
  });

  it("wraps and unwraps a blockquote", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("quoted");
    commands.toggleBlockquote();
    expect(docOf(editor).document.children[0]?.type).toBe("blockquote");
    commands.toggleBlockquote();
    expect(docOf(editor).document.children[0]?.type).toBe("paragraph");
  });

  it("sets and unsets a link over the selection", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("click me");
    editor.commands.selectAll();
    commands.setLink("https://example.com");
    const para = docOf(editor).document.children[0];
    if (para?.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children[0]).toMatchObject({ type: "link", url: "https://example.com" });
    editor.commands.selectAll();
    commands.unsetLink();
    const after = docOf(editor).document.children[0];
    if (after?.type !== "paragraph") throw new Error("expected paragraph");
    expect(after.children[0]?.type).toBe("span");
  });

  it("inserts inline records and blocks", () => {
    const { editor, commands } = makeEditor();
    commands.insertInlineItem("rec_1");
    commands.insertBlock("blk_1");
    const dast = docOf(editor);
    const types = dast.document.children.map((c) => c.type);
    expect(types).toContain("block");
    const para = dast.document.children.find((c) => c.type === "paragraph");
    if (para?.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.some((c) => c.type === "inlineItem")).toBe(true);
  });
});

describe("table surgery", () => {
  it("inserts a table and adds/removes rows and columns", () => {
    const { editor, commands } = makeEditor();
    expect(commands.insertTable(2, 2)).toBe(true);
    // Put the cursor inside the first cell.
    editor.commands.setTextSelection(4);
    expect(buildCan(editor).tableActions).toBe(true);

    expect(commands.addRowAfter()).toBe(true);
    let table = docOf(editor).document.children.find((c) => c.type === "table");
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.children).toHaveLength(3);
    expect(table.children[0].children).toHaveLength(2);

    editor.commands.setTextSelection(4);
    expect(commands.addColumnAfter()).toBe(true);
    table = docOf(editor).document.children.find((c) => c.type === "table");
    if (table?.type !== "table") throw new Error("expected table");
    for (const row of table.children) expect(row.children).toHaveLength(3);

    editor.commands.setTextSelection(4);
    expect(commands.deleteColumn()).toBe(true);
    table = docOf(editor).document.children.find((c) => c.type === "table");
    if (table?.type !== "table") throw new Error("expected table");
    for (const row of table.children) expect(row.children).toHaveLength(2);

    editor.commands.setTextSelection(4);
    expect(commands.deleteRow()).toBe(true);
    table = docOf(editor).document.children.find((c) => c.type === "table");
    if (table?.type !== "table") throw new Error("expected table");
    expect(table.children).toHaveLength(2);

    // Deleting the final rows removes the table entirely (NonEmptyArray grammar).
    editor.commands.setTextSelection(4);
    commands.deleteRow();
    editor.commands.setTextSelection(4);
    commands.deleteRow();
    expect(docOf(editor).document.children.some((c) => c.type === "table")).toBe(false);
  });

  it("table commands refuse outside a table", () => {
    const { editor, commands } = makeEditor();
    editor.commands.insertContent("not a table");
    expect(commands.addRowAfter()).toBe(false);
    expect(buildCan(editor).tableActions).toBe(false);
  });
});

describe("custom marks", () => {
  it("registers, toggles, and serializes customMark_* marks", () => {
    const { editor, commands } = makeEditor({ customMarks: ["customMark_kbd"] });
    editor.commands.insertContent("Cmd+K");
    editor.commands.selectAll();
    commands.toggleMark("customMark_kbd");
    const para = docOf(editor).document.children[0];
    if (para?.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children[0]).toMatchObject({ type: "span", marks: ["customMark_kbd"] });
  });

  it("loading content with an unregistered custom mark fails loudly", () => {
    const doc: DastDocument = {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "paragraph", children: [{ type: "span", value: "x", marks: ["customMark_nope"] }] },
        ],
      },
    };
    expect(() => makeEditor({}, doc)).toThrow();
  });
});

describe("HTML paste normalization", () => {
  it("normalizes pasted-ish HTML into the DAST grammar", () => {
    const { editor } = makeEditor();
    editor.commands.insertContent(
      '<h2>Title</h2><p>Some <b>bold</b> and <i>italic</i> and <a href="https://x.com">a link</a></p><ul><li><p>one</p></li><li><p>two</p></li></ul><blockquote><p>quote</p></blockquote>'
    );
    const dast = docOf(editor);
    const types = dast.document.children.map((c) => c.type);
    expect(types).toEqual(expect.arrayContaining(["heading", "paragraph", "list", "blockquote"]));
    const para = dast.document.children.find((c) => c.type === "paragraph");
    if (para?.type !== "paragraph") throw new Error("expected paragraph");
    expect(para.children.some((c) => c.type === "span" && c.marks?.includes("strong"))).toBe(true);
    expect(para.children.some((c) => c.type === "link")).toBe(true);
  });

  it("drops structure the grammar forbids instead of storing it (loose li content)", () => {
    const { editor } = makeEditor();
    // Bare text directly inside <li> — the grammar wants li > paragraph.
    editor.commands.insertContent("<ul><li>bare</li></ul>");
    const dast = docOf(editor);
    const list = dast.document.children.find((c) => c.type === "list");
    if (list?.type !== "list") throw new Error("expected list");
    expect(list.children[0]?.children[0]?.type).toBe("paragraph");
  });
});

describe("trailing paragraph after a final block atom", () => {
  it("keeps a paragraph after a trailing embedded block so the cursor can escape", () => {
    const { commands, editor } = makeEditor();
    commands.insertBlock("blk_1");
    const children = docOf(editor).document.children;
    expect(children[children.length - 1]?.type).toBe("paragraph");
  });
});
