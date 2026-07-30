/**
 * Tiptap 3 extensions mirroring the DAST content grammar.
 *
 * The grammar here must stay 1:1 with agent-cms `src/dast/schema.ts` — that is
 * the entire argument for ProseMirror (ticket 14): `NodeSpec.content` *is* the
 * DAST grammar, enforced by the engine, so invalid documents fail loudly at
 * load instead of being silently repaired.
 *
 * Naming: DAST `block` is named `blockNode` in ProseMirror because `block`
 * would collide with a group name; DAST `code` is `codeNode` because we also
 * have a `code` mark. The codec translates names both ways.
 *
 * No CSS ships. renderHTML emits bare semantic HTML; atoms (embedded blocks,
 * inline records) render a placeholder element unless the host supplies a
 * node view (see useDastEditor's blockView).
 */
import {
  Mark,
  Node,
  markInputRule,
  markPasteRule,
  nodeInputRule,
  textblockTypeInputRule,
  wrappingInputRule,
} from "@tiptap/core";
import { Dropcursor, Gapcursor, Placeholder, TrailingNode, UndoRedo } from "@tiptap/extensions";

const GROUP_BLOCK = "blockLevel";

export interface DastExtensionOptions {
  /**
   * "document" — root accepts the full block-level union (default).
   * "blocks_only" — root accepts only embedded block nodes
   * (`blocks_only` validator mode, agent-cms src/db/validators.ts).
   */
  mode?: "document" | "blocks_only";
  /**
   * Project-defined marks to register, e.g. ["customMark_kbd"]. Content
   * carrying a custom mark that is NOT listed here fails loudly at load —
   * same stance as every other schema violation. Each renders as
   * `<span data-mark="customMark_x">`; the host styles it.
   */
  customMarks?: readonly `customMark_${string}`[];
  /** Placeholder text shown in an empty document. */
  placeholder?: string;
}

export const DastDoc = Node.create<{ mode: "document" | "blocks_only" }>({
  name: "doc",
  topNode: true,
  addOptions() {
    return { mode: "document" };
  },
  content() {
    return this.options.mode === "blocks_only" ? "blockNode+" : `${GROUP_BLOCK}+`;
  },
});

export const DastText = Node.create({
  name: "text",
  group: "inline",
});

export const DastParagraph = Node.create({
  name: "paragraph",
  group: GROUP_BLOCK,
  content: "inline*",
  addAttributes() {
    return { style: { default: null } };
  },
  parseHTML() {
    return [{ tag: "p" }];
  },
  renderHTML() {
    return ["p", 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-0": () => this.editor.commands.setNode(this.name),
    };
  },
});

export const DastHeading = Node.create({
  name: "heading",
  group: GROUP_BLOCK,
  content: "inline*",
  defining: true,
  addAttributes() {
    return { level: { default: 1 }, style: { default: null } };
  },
  parseHTML() {
    return [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, attrs: { level } }));
  },
  renderHTML({ node }) {
    return [`h${node.attrs.level}`, 0];
  },
  addKeyboardShortcuts() {
    return Object.fromEntries(
      [1, 2, 3, 4, 5, 6].map((level) => [
        `Mod-Alt-${level}`,
        () => this.editor.commands.toggleNode(this.name, "paragraph", { level }),
      ])
    );
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^(#{1,6})\s$/,
        type: this.type,
        getAttributes: (match) => ({ level: match[1]?.length ?? 1 }),
      }),
    ];
  },
});

export const DastList = Node.create({
  name: "list",
  group: GROUP_BLOCK,
  content: "listItem+",
  addAttributes() {
    return { style: { default: "bulleted" } };
  },
  parseHTML() {
    return [
      { tag: "ul", attrs: { style: "bulleted" } },
      { tag: "ol", attrs: { style: "numbered" } },
    ];
  },
  renderHTML({ node }) {
    return [node.attrs.style === "numbered" ? "ol" : "ul", 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-8": () => this.editor.commands.toggleList(this.name, "listItem", false, { style: "bulleted" }),
      "Mod-Shift-7": () => this.editor.commands.toggleList(this.name, "listItem", false, { style: "numbered" }),
    };
  },
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*([-+*])\s$/,
        type: this.type,
        getAttributes: { style: "bulleted" },
      }),
      wrappingInputRule({
        find: /^(\d+)\.\s$/,
        type: this.type,
        getAttributes: { style: "numbered" },
      }),
    ];
  },
});

export const DastListItem = Node.create({
  name: "listItem",
  content: "(paragraph | list)+",
  defining: true,
  parseHTML() {
    return [{ tag: "li" }];
  },
  renderHTML() {
    return ["li", 0];
  },
  addKeyboardShortcuts() {
    return {
      Enter: () => this.editor.commands.splitListItem(this.name),
      Tab: () => this.editor.commands.sinkListItem(this.name),
      "Shift-Tab": () => this.editor.commands.liftListItem(this.name),
    };
  },
});

export const DastBlockquote = Node.create({
  name: "blockquote",
  group: GROUP_BLOCK,
  content: "paragraph+",
  defining: true,
  addAttributes() {
    return { attribution: { default: null } };
  },
  parseHTML() {
    return [{ tag: "blockquote" }];
  },
  renderHTML() {
    return ["blockquote", 0];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Shift-b": () => this.editor.commands.toggleWrap(this.name),
    };
  },
  addInputRules() {
    return [wrappingInputRule({ find: /^\s*>\s$/, type: this.type })];
  },
});

export const DastCode = Node.create({
  name: "codeNode",
  group: GROUP_BLOCK,
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() {
    return { language: { default: null }, highlight: { default: null } };
  },
  parseHTML() {
    return [{ tag: "pre", preserveWhitespace: "full" }];
  },
  renderHTML() {
    return ["pre", ["code", 0]];
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Alt-c": () => this.editor.commands.toggleNode(this.name, "paragraph"),
    };
  },
  addInputRules() {
    return [
      textblockTypeInputRule({
        find: /^```([a-z0-9]+)?\s$/,
        type: this.type,
        getAttributes: (match) => ({ language: match[1] ?? null }),
      }),
    ];
  },
});

export const DastThematicBreak = Node.create({
  name: "thematicBreak",
  group: GROUP_BLOCK,
  atom: true,
  parseHTML() {
    return [{ tag: "hr" }];
  },
  renderHTML() {
    return ["hr"];
  },
  addInputRules() {
    return [nodeInputRule({ find: /^(?:---|___|\*\*\*)\s$/, type: this.type })];
  },
});

export const DastBlock = Node.create({
  name: "blockNode",
  group: GROUP_BLOCK,
  atom: true,
  draggable: true,
  addAttributes() {
    return { item: { default: null } };
  },
  parseHTML() {
    return [{ tag: "div[data-dast-block]" }];
  },
  renderHTML({ node }) {
    return ["div", { "data-dast-block": node.attrs.item }];
  },
});

export const DastInlineBlock = Node.create({
  name: "inlineBlock",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { item: { default: null } };
  },
  parseHTML() {
    return [{ tag: "span[data-dast-inline-block]" }];
  },
  renderHTML({ node }) {
    return ["span", { "data-dast-inline-block": node.attrs.item }];
  },
});

export const DastInlineItem = Node.create({
  name: "inlineItem",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return { item: { default: null } };
  },
  parseHTML() {
    return [{ tag: "span[data-dast-inline-item]" }];
  },
  renderHTML({ node }) {
    return ["span", { "data-dast-inline-item": node.attrs.item }];
  },
});

export const DastTable = Node.create({
  name: "table",
  group: GROUP_BLOCK,
  content: "tableRow+",
  isolating: true,
  parseHTML() {
    return [{ tag: "table" }];
  },
  renderHTML() {
    return ["table", ["tbody", 0]];
  },
});

export const DastTableRow = Node.create({
  name: "tableRow",
  content: "tableCell+",
  parseHTML() {
    return [{ tag: "tr" }];
  },
  renderHTML() {
    return ["tr", 0];
  },
});

export const DastTableCell = Node.create({
  name: "tableCell",
  // paragraph+ — see agent-cms ticket 17: mixing inline and block siblings in
  // a cell is unrepresentable in ProseMirror and the CMS schema forbids it.
  content: "paragraph+",
  isolating: true,
  parseHTML() {
    return [{ tag: "td" }, { tag: "th" }];
  },
  renderHTML() {
    return ["td", 0];
  },
});

// --- Marks (DAST span marks + link/itemLink, which are marks in PM) ---

interface SimpleMarkConfig {
  name: string;
  tag: string;
  shortcut?: string;
  inputFind?: RegExp;
  pasteFind?: RegExp;
  extraParseHTML?: ReadonlyArray<{ tag?: string; style?: string }>;
}

const simpleMark = ({ name, tag, shortcut, inputFind, pasteFind, extraParseHTML }: SimpleMarkConfig) =>
  Mark.create({
    name,
    parseHTML() {
      return [{ tag }, ...(extraParseHTML ?? [])];
    },
    renderHTML() {
      return [tag, 0];
    },
    addKeyboardShortcuts() {
      if (!shortcut) return {};
      return { [shortcut]: () => this.editor.commands.toggleMark(this.name) };
    },
    addInputRules() {
      return inputFind ? [markInputRule({ find: inputFind, type: this.type })] : [];
    },
    addPasteRules() {
      return pasteFind ? [markPasteRule({ find: pasteFind, type: this.type })] : [];
    },
  });

export const DastStrong = simpleMark({
  name: "strong",
  tag: "strong",
  shortcut: "Mod-b",
  inputFind: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))$/,
  pasteFind: /(?:^|\s)(\*\*(?!\s+\*\*)((?:[^*]+))\*\*(?!\s+\*\*))/g,
  extraParseHTML: [{ tag: "b" }],
});
export const DastEmphasis = simpleMark({
  name: "emphasis",
  tag: "em",
  shortcut: "Mod-i",
  inputFind: /(?:^|\s)(\*(?!\s+\*)((?:[^*]+))\*(?!\s+\*))$/,
  extraParseHTML: [{ tag: "i" }],
});
export const DastUnderline = simpleMark({ name: "underline", tag: "u", shortcut: "Mod-u" });
export const DastStrikethrough = simpleMark({
  name: "strikethrough",
  tag: "s",
  shortcut: "Mod-Shift-x",
  inputFind: /(?:^|\s)(~~(?!\s+~~)((?:[^~]+))~~(?!\s+~~))$/,
  extraParseHTML: [{ tag: "del" }, { tag: "strike" }],
});
export const DastCodeMark = simpleMark({
  name: "code",
  tag: "code",
  shortcut: "Mod-e",
  inputFind: /(?:^|\s)(`(?!\s+`)((?:[^`]+))`(?!\s+`))$/,
});
export const DastHighlight = simpleMark({ name: "highlight", tag: "mark", shortcut: "Mod-Shift-h" });

/** A project-defined mark (`customMark_*`). Renders as a data-attributed span. */
export const createCustomMark = (name: `customMark_${string}`) =>
  Mark.create({
    name,
    parseHTML() {
      return [{ tag: `span[data-mark="${name}"]` }];
    },
    renderHTML() {
      return ["span", { "data-mark": name }, 0];
    },
  });

export const DastLink = Mark.create({
  name: "link",
  inclusive: false,
  addAttributes() {
    return { url: { default: null }, meta: { default: null } };
  },
  parseHTML() {
    return [{ tag: "a[href]:not([data-dast-item])" }];
  },
  renderHTML({ mark }) {
    return ["a", { href: mark.attrs.url }, 0];
  },
});

export const DastItemLink = Mark.create({
  name: "itemLink",
  inclusive: false,
  addAttributes() {
    return { item: { default: null }, meta: { default: null } };
  },
  parseHTML() {
    return [{ tag: "a[data-dast-item]" }];
  },
  renderHTML({ mark }) {
    return ["a", { "data-dast-item": mark.attrs.item }, 0];
  },
});

/**
 * The full extension set for a structured_text field.
 * Pass the result to Tiptap's `useEditor({ extensions })` or `getSchema()`.
 */
export function createDastExtensions(options: DastExtensionOptions = {}) {
  const mode = options.mode ?? "document";
  return [
    DastDoc.configure({ mode }),
    DastText,
    DastParagraph,
    DastHeading,
    DastList,
    DastListItem,
    DastBlockquote,
    DastCode,
    DastThematicBreak,
    DastBlock,
    DastInlineBlock,
    DastInlineItem,
    DastTable,
    DastTableRow,
    DastTableCell,
    DastStrong,
    DastEmphasis,
    DastUnderline,
    DastStrikethrough,
    DastCodeMark,
    DastHighlight,
    DastLink,
    DastItemLink,
    ...(options.customMarks ?? []).map(createCustomMark),
    UndoRedo,
    Gapcursor,
    Dropcursor.configure({ class: "dast-dropcursor" }),
    ...(options.placeholder ? [Placeholder.configure({ placeholder: options.placeholder })] : []),
    // Guarantees the document never ends in an atom the cursor can't get
    // behind. Document mode only — blocks_only forbids paragraphs entirely.
    ...(mode === "document" ? [TrailingNode.configure({ node: "paragraph" })] : []),
  ];
}
