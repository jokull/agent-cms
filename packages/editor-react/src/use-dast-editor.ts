/**
 * useDastEditor — the headless React hook for a structured_text field.
 *
 * Headless in the Radix sense (ticket 15 reading B): Tiptap/ProseMirror owns
 * contenteditable, selection, IME, undo, and the DAST grammar; the host owns
 * every pixel of chrome. This hook renders nothing. Mount the editor surface
 * with Tiptap's <EditorContent editor={handle.editor} /> wherever the host
 * wants, build toolbars against `handle.commands` + useDastEditorState.
 *
 * Embedded blocks: DAST block/inlineBlock nodes are atoms whose payloads live
 * in the envelope's `blocks` map, not in the document. The host supplies a
 * React component via `blockView`; the generated per-project types narrow the
 * payload union so a missing or misnamed block type is a compile error.
 */
import { ReactNodeViewRenderer, useEditor, type Editor, type NodeViewProps } from "@tiptap/react";
import type { ComponentType } from "react";
import { createElement, useMemo, useRef } from "react";
import { dastToPm, pmToDast } from "./bridge/codec.js";
import type { DastDocument } from "./bridge/dast-types.js";
import {
  DastBlock,
  DastInlineBlock,
  createDastExtensions,
  type DastExtensionOptions,
} from "./bridge/extensions.js";
import { buildCan, buildCommands, type DastCan, type DastCommands } from "./commands.js";

/** The envelope a structured_text field carries over REST. */
export interface StructuredTextEnvelope<Block = unknown> {
  value: DastDocument;
  blocks: Record<string, Block>;
}

export interface BlockViewProps<Block = unknown> {
  /** Block id — the DAST node's `item`. */
  id: string;
  /** The block payload row from the envelope's blocks map (undefined if unresolved). */
  block: Block | undefined;
  /** True when rendered inline (DAST inlineBlock) rather than block-level. */
  inline: boolean;
  /** Remove this block node from the document. */
  remove: () => void;
}

export interface UseDastEditorOptions<Block> {
  /** Initial envelope. Null starts an empty document. */
  value: StructuredTextEnvelope<Block> | null;
  /** structured_text vs blocks_only field mode. */
  mode?: DastExtensionOptions["mode"];
  /** Project-defined marks this field allows (from the field's config). */
  customMarks?: DastExtensionOptions["customMarks"];
  /** Placeholder shown while the document is empty. */
  placeholder?: string;
  editable?: boolean;
  /** Called with the serialized DAST document on every content change. */
  onChange?: (value: DastDocument) => void;
  /**
   * Host-supplied component rendered for embedded block atoms. Receives the
   * block payload looked up from the envelope. One component serves both
   * positions; `inline` discriminates.
   */
  blockView?: ComponentType<BlockViewProps<Block>>;
}

export interface DastEditorHandle {
  /** The Tiptap editor, for <EditorContent /> and anything not covered below. Null until mounted. */
  editor: Editor | null;
  /** Typed commands in DAST vocabulary. No-ops until the editor mounts. */
  commands: DastCommands;
  /** Introspection for disabling controls. Snapshot at call time — pair with useDastEditorState for reactivity. */
  can: () => DastCan | null;
  /** Serialize the current document to DAST. */
  getValue: () => DastDocument;
  /** Replace the document from a DAST value (e.g. external update). */
  setValue: (value: DastDocument) => void;
}

const EMPTY_DOC: DastDocument = {
  schema: "dast",
  document: { type: "root", children: [{ type: "paragraph", children: [] }] },
};

/** Commands that safely no-op while the editor is unmounted. */
function lazyCommands(get: () => Editor | null): DastCommands {
  const commandsFor = (editor: Editor | null) => (editor ? buildCommands(editor) : null);
  const call = <K extends keyof DastCommands>(key: K): DastCommands[K] =>
    ((...args: never[]) => {
      const commands = commandsFor(get());
      if (!commands) return false;
      const fn: (...inner: never[]) => unknown = commands[key];
      return fn(...args);
    }) as DastCommands[K];
  return {
    focus: call("focus"),
    undo: call("undo"),
    redo: call("redo"),
    toggleMark: call("toggleMark"),
    setParagraph: call("setParagraph"),
    toggleHeading: call("toggleHeading"),
    toggleList: call("toggleList"),
    toggleBlockquote: call("toggleBlockquote"),
    toggleCodeBlock: call("toggleCodeBlock"),
    setLink: call("setLink"),
    unsetLink: call("unsetLink"),
    setItemLink: call("setItemLink"),
    unsetItemLink: call("unsetItemLink"),
    insertInlineItem: call("insertInlineItem"),
    insertBlock: call("insertBlock"),
    insertThematicBreak: call("insertThematicBreak"),
    insertTable: call("insertTable"),
    addRowAfter: call("addRowAfter"),
    deleteRow: call("deleteRow"),
    addColumnAfter: call("addColumnAfter"),
    deleteColumn: call("deleteColumn"),
  };
}

export function useDastEditor<Block>(
  options: UseDastEditorOptions<Block>
): DastEditorHandle {
  const { value, mode, customMarks, placeholder, editable, onChange, blockView } = options;

  // The envelope's blocks map, readable by node views without re-creating the
  // editor when payloads change.
  const blocksRef = useRef<Record<string, Block> | undefined>(value?.blocks);
  blocksRef.current = value?.blocks;

  const extensions = useMemo(() => {
    const base = createDastExtensions({
      mode: mode ?? "document",
      ...(customMarks ? { customMarks } : {}),
      ...(placeholder ? { placeholder } : {}),
    });
    if (!blockView) return base;
    const lookupBlock = (blocks: Record<string, Block> | undefined, id: string): Block | undefined =>
      blocks === undefined ? undefined : blocks[id];
    const BlockViewAdapter = (props: NodeViewProps) => {
      const id = typeof props.node.attrs.item === "string" ? props.node.attrs.item : "";
      const viewProps: BlockViewProps<Block> = {
        id,
        block: lookupBlock(blocksRef.current, id),
        inline: props.node.type.name === "inlineBlock",
        remove: () => props.deleteNode(),
      };
      return createElement(blockView, viewProps);
    };
    return base.map((extension) => {
      if (extension.name === DastBlock.name) {
        return DastBlock.extend({
          addNodeView: () => ReactNodeViewRenderer(BlockViewAdapter),
        });
      }
      if (extension.name === DastInlineBlock.name) {
        return DastInlineBlock.extend({
          addNodeView: () => ReactNodeViewRenderer(BlockViewAdapter),
        });
      }
      return extension;
    });
  }, [mode, customMarks, placeholder, blockView]);

  const editor = useEditor(
    {
      extensions,
      editable: editable ?? true,
      // Invalid content must fail loudly (ticket 14's stance) — without this
      // Tiptap logs and silently drops schema-violating nodes.
      enableContentCheck: true,
      content: dastToPm(value?.value ?? EMPTY_DOC),
      ...(onChange
        ? { onUpdate: ({ editor: current }: { editor: Editor }) => onChange(pmToDast(current.getJSON())) }
        : {}),
    },
    [extensions]
  );

  const editorRef = useRef<Editor | null>(editor);
  editorRef.current = editor;

  const commands = useMemo(() => lazyCommands(() => editorRef.current), []);

  return {
    editor,
    commands,
    can: () => (editor ? buildCan(editor) : null),
    getValue: () => (editor ? pmToDast(editor.getJSON()) : (value?.value ?? EMPTY_DOC)),
    setValue: (next) => {
      editor?.commands.setContent(dastToPm(next));
    },
  };
}
