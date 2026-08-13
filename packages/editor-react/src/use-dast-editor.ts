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
import type { AnyExtension } from "@tiptap/core";
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

export interface BlockViewProps<Block = unknown, Props = undefined> {
  /** Block id — the DAST node's `item`. */
  id: string;
  /** The block payload row from the envelope's blocks map (undefined if unresolved). */
  block: Block | undefined;
  /** True when rendered inline (DAST inlineBlock) rather than block-level. */
  inline: boolean;
  /** Remove this block node from the document. */
  remove: () => void;
  /**
   * Whatever the host passed as `blockViewProps` — edit callbacks, the current
   * locale, a drag handle, anything. Delivered through a ref, so changing it
   * does NOT re-create the extensions or remount node views. `undefined` when
   * the option is omitted.
   */
  props: Props | undefined;
}

export interface UseDastEditorOptions<Block, Props = undefined> {
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
   * Called when `commands.insertBlock(draft)` mints a block: the host persists
   * the payload under `id` in whatever state backs the envelope. The toolkit has
   * ALREADY registered the payload for rendering by the time this fires, so the
   * host's state update can land whenever it likes — insertion is not
   * order-sensitive.
   */
  onBlockCreate?: (id: string, draft: Block) => void;
  /**
   * Host-supplied component rendered for embedded block atoms. Receives the
   * block payload looked up from the envelope. One component serves both
   * positions; `inline` discriminates.
   */
  blockView?: ComponentType<BlockViewProps<Block, Props>>;
  /**
   * Host props handed to every `blockView` render as `props`. Read through a
   * ref on each render, so a fresh object every keystroke costs nothing and never
   * remounts a node view.
   */
  blockViewProps?: Props;
  /**
   * Extra Tiptap extensions appended AFTER the DAST extensions (e.g. a
   * slash-command plugin). Pass a STABLE array (memoize it or hoist it to
   * module scope) — a fresh array every render rebuilds the whole editor.
   */
  extensions?: AnyExtension[];
}

export interface DastEditorHandle<Block = unknown> {
  /** The Tiptap editor, for <EditorContent /> and anything not covered below. Null until mounted. */
  editor: Editor | null;
  /** Typed commands in DAST vocabulary. No-ops until the editor mounts. */
  commands: DastCommands<Block>;
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
function lazyCommands<Block>(
  get: () => Editor | null,
  registerBlock: (draft: Block) => string,
): DastCommands<Block> {
  const commandsFor = (editor: Editor | null) =>
    editor ? buildCommands<Block>(editor, registerBlock) : null;
  const call = <K extends keyof DastCommands<Block>>(key: K): DastCommands<Block>[K] =>
    ((...args: never[]) => {
      const commands = commandsFor(get());
      if (!commands) return false;
      const fn: (...inner: never[]) => unknown = commands[key];
      return fn(...args);
    }) as DastCommands<Block>[K];
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

/** Read an `id` off an unknown payload without asserting its type. */
function draftId(draft: unknown): string | null {
  if (typeof draft !== "object" || draft === null) return null;
  const id = Reflect.get(draft, "id");
  return typeof id === "string" && id.length > 0 ? id : null;
}

function mintId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `blk_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function useDastEditor<Block, Props = undefined>(
  options: UseDastEditorOptions<Block, Props>
): DastEditorHandle<Block> {
  const {
    value,
    mode,
    customMarks,
    placeholder,
    editable,
    onChange,
    onBlockCreate,
    blockView,
    extensions: hostExtensions,
  } = options;

  // The envelope's blocks map, readable by node views without re-creating the
  // editor when payloads change.
  const blocksRef = useRef<Record<string, Block> | undefined>(value?.blocks);
  blocksRef.current = value?.blocks;

  // Payloads minted by `insertBlock(draft)` since the host last handed us an
  // envelope. Registering them here — synchronously, before the atom exists —
  // is what makes block insertion order-insensitive: the node view resolves on
  // its FIRST render whether or not the host's setState has landed.
  const draftsRef = useRef<Record<string, Block>>({});
  for (const id of Object.keys(draftsRef.current)) {
    if (value?.blocks && Object.prototype.hasOwnProperty.call(value.blocks, id)) {
      // The host caught up; its copy is authoritative from here.
      delete draftsRef.current[id];
    }
  }

  // Host props for block views: a ref, so a new object per render neither
  // re-creates the extensions nor remounts a node view.
  const blockViewPropsRef = useRef<Props | undefined>(options.blockViewProps);
  blockViewPropsRef.current = options.blockViewProps;

  const onBlockCreateRef = useRef<((id: string, draft: Block) => void) | undefined>(onBlockCreate);
  onBlockCreateRef.current = onBlockCreate;

  const registerBlock = useRef((draft: Block): string => {
    const id = draftId(draft) ?? mintId();
    draftsRef.current[id] = draft;
    onBlockCreateRef.current?.(id, draft);
    return id;
  }).current;

  // Compare the mark list BY CONTENT: hosts write the option inline
  // (`customMarks: ["customMark_kbd"]`), and a fresh array per render would
  // otherwise rebuild the extensions — and with them the whole editor.
  const customMarksKey = customMarks ? customMarks.join("\u0000") : "";

  const extensions = useMemo(() => {
    const base = createDastExtensions({
      mode: mode ?? "document",
      ...(customMarks ? { customMarks } : {}),
      ...(placeholder ? { placeholder } : {}),
    });
    if (!blockView) return hostExtensions ? [...base, ...hostExtensions] : base;
    // The host's envelope wins; a freshly minted draft covers the frames before
    // the host's state catches up.
    const lookupBlock = (id: string): Block | undefined =>
      blocksRef.current?.[id] ?? draftsRef.current[id];
    const BlockViewAdapter = (props: NodeViewProps) => {
      const id = typeof props.node.attrs.item === "string" ? props.node.attrs.item : "";
      const viewProps: BlockViewProps<Block, Props> = {
        id,
        block: lookupBlock(id),
        inline: props.node.type.name === "inlineBlock",
        remove: () => props.deleteNode(),
        props: blockViewPropsRef.current,
      };
      return createElement(blockView, viewProps);
    };
    const withBlockView = base.map((extension) => {
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
    return hostExtensions ? [...withBlockView, ...hostExtensions] : withBlockView;
    // customMarksKey stands in for customMarks (content equality).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, customMarksKey, placeholder, blockView, hostExtensions]);

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

  const commands = useMemo(
    () => lazyCommands<Block>(() => editorRef.current, registerBlock),
    [registerBlock],
  );

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
