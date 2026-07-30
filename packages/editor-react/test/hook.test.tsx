// @vitest-environment jsdom
/**
 * Hook-level tests over a really-mounted React tree (react-dom + jsdom):
 * host props reaching `blockView`, the reactive `can` cluster, and
 * order-insensitive `insertBlock(draft)`.
 */
import { EditorContent, NodeViewWrapper } from "@tiptap/react";
import { act, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DastDocument } from "../src/bridge/dast-types.js";
import type { BlockViewProps } from "../src/use-dast-editor.js";
import { useDastEditor } from "../src/use-dast-editor.js";
import { useDastEditorState, type DastEditorSnapshot } from "../src/use-dast-editor-state.js";

declare global {
  // React's act() environment flag.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<{ root: Root; container: HTMLElement }> = [];

/** Let React flush work scheduled by Tiptap's node-view portal renderer. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function mount(element: ReactElement): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => {
    root.render(element);
  });
  return container;
}

afterEach(() => {
  while (roots.length > 0) {
    const entry = roots.pop();
    if (!entry) continue;
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

interface DemoBlock {
  id?: string;
  _type: "hero";
  headline: string;
}

interface HostProps {
  readonly edit: (id: string) => void;
  readonly label: string;
}

const CUSTOM_MARKS: ReadonlyArray<`customMark_${string}`> = ["customMark_kbd"];

/** Every render of every block card, in order — the flash detector. */
const renderLog: string[] = [];
let mountCount = 0;

function BlockCard({ id, block, remove, props }: BlockViewProps<DemoBlock, HostProps>) {
  renderLog.push(block ? `${block.headline}@${props?.label ?? "no-props"}` : "UNRESOLVED");
  return (
    <NodeViewWrapper as="div" data-testid="card">
      <span data-testid="headline">{block ? block.headline : "unresolved block payload"}</span>
      <span data-testid="hostlabel">{props?.label ?? "no-props"}</span>
      <button type="button" data-testid="edit" onClick={() => props?.edit(id)}>
        edit
      </button>
      <button type="button" onClick={remove}>
        ×
      </button>
    </NodeViewWrapper>
  );
}

function CountingCard(cardProps: BlockViewProps<DemoBlock, HostProps>) {
  useState(() => {
    mountCount += 1;
    return null;
  });
  return <BlockCard {...cardProps} />;
}

describe("blockViewProps (FRICTION #9)", () => {
  it("delivers typed host props to every block view render", () => {
    renderLog.length = 0;
    const edited: string[] = [];
    function Host() {
      const [label, setLabel] = useState("first");
      const handle = useDastEditor<DemoBlock, HostProps>({
        value: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "block", item: "b1" }] },
          },
          blocks: { b1: { id: "b1", _type: "hero", headline: "Hello" } },
        },
        blockView: BlockCard,
        blockViewProps: { edit: (id) => edited.push(id), label },
      });
      return (
        <>
          <button type="button" data-testid="relabel" onClick={() => setLabel("second")}>
            relabel
          </button>
          <EditorContent editor={handle.editor} />
        </>
      );
    }

    const container = mount(<Host />);
    expect(container.querySelector("[data-testid=hostlabel]")?.textContent).toBe("first");

    // A callback smuggled in as a host prop — no React context needed.
    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid=edit]")?.click();
    });
    expect(edited).toEqual(["b1"]);
  });

  it("new props objects do not remount the node view", () => {
    renderLog.length = 0;
    mountCount = 0;
    function Host() {
      const [tick, setTick] = useState(0);
      const handle = useDastEditor<DemoBlock, HostProps>({
        value: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "block", item: "b1" }] },
          },
          blocks: { b1: { id: "b1", _type: "hero", headline: "Hello" } },
        },
        blockView: CountingCard,
        // A brand-new object on every render — the ref indirection must absorb it.
        blockViewProps: { edit: () => undefined, label: `tick-${tick}` },
      });
      return (
        <>
          <button type="button" data-testid="tick" onClick={() => setTick((n) => n + 1)}>
            tick
          </button>
          <EditorContent editor={handle.editor} />
        </>
      );
    }

    const container = mount(<Host />);
    const mountsAfterFirstRender = mountCount;
    expect(mountsAfterFirstRender).toBe(1);
    for (let i = 0; i < 3; i++) {
      act(() => {
        container.querySelector<HTMLButtonElement>("[data-testid=tick]")?.click();
      });
    }
    expect(mountCount).toBe(mountsAfterFirstRender);
  });
});

describe("reactive can (FRICTION #20)", () => {
  it("exposes insertBlock / table / undo / per-mark booleans in the snapshot", async () => {
    const snapshots: DastEditorSnapshot[] = [];
    let insertTable: () => void = () => undefined;
    let type: () => void = () => undefined;

    function Host() {
      const handle = useDastEditor<DemoBlock>({ value: null, customMarks: CUSTOM_MARKS });
      const state = useDastEditorState(handle);
      if (state !== null) snapshots.push(state);
      insertTable = () => handle.commands.insertTable(2, 2);
      type = () => handle.editor?.commands.insertContent("hello");
      return <EditorContent editor={handle.editor} />;
    }

    const last = (): DastEditorSnapshot => {
      const state = snapshots[snapshots.length - 1];
      if (state === undefined) throw new Error("no snapshot yet");
      return state;
    };

    mount(<Host />);
    await flush();
    expect(snapshots.length).toBeGreaterThan(0);
    expect(last().can.insertBlock).toBe(true);
    expect(last().can.tableActions).toBe(false);
    expect(last().can.undo).toBe(false);
    expect(last().can.toggleMark.strong).toBe(true);
    expect(last().can.toggleMark.customMark_kbd).toBe(true);

    act(() => type());
    await flush();
    // The snapshot re-rendered with a fresh answer — that is the whole point.
    expect(last().can.undo).toBe(true);
    expect(last().canUndo).toBe(last().can.undo);

    act(() => insertTable());
    await flush();
    expect(last().can.tableActions).toBe(true);
  });
});

describe("insertBlock(draft) (FRICTION #7)", () => {
  it("renders the payload on the first frame and hands the host the id", async () => {
    renderLog.length = 0;
    const created: Array<{ id: string; draft: DemoBlock }> = [];

    function Host() {
      const [blocks, setBlocks] = useState<Record<string, DemoBlock>>({});
      const [doc, setDoc] = useState<DastDocument>({
        schema: "dast",
        document: { type: "root", children: [{ type: "paragraph", children: [] }] },
      });
      const handle = useDastEditor<DemoBlock, HostProps>({
        value: { value: doc, blocks },
        blockView: BlockCard,
        blockViewProps: { edit: () => undefined, label: "host" },
        onChange: setDoc,
        onBlockCreate: (id, draft) => {
          created.push({ id, draft });
          // Deliberately AFTER the insert, in a state update that lands a frame
          // later — the old API rendered "unresolved block payload" here.
          setBlocks((prev) => ({ ...prev, [id]: { ...draft, id } }));
        },
      });
      return (
        <>
          <button
            type="button"
            data-testid="insert"
            onClick={() => handle.commands.insertBlock({ _type: "hero", headline: "Fresh hero" })}
          >
            insert
          </button>
          <EditorContent editor={handle.editor} />
        </>
      );
    }

    const container = mount(<Host />);
    act(() => {
      container.querySelector<HTMLButtonElement>("[data-testid=insert]")?.click();
    });
    await flush();

    expect(created).toHaveLength(1);
    expect(created[0]?.id).toMatch(/.+/);
    expect(created[0]?.draft.headline).toBe("Fresh hero");
    expect(container.querySelector("[data-testid=headline]")?.textContent).toBe("Fresh hero");
    // No frame ever saw an unresolved payload.
    expect(renderLog).not.toContain("UNRESOLVED");
    expect(renderLog.length).toBeGreaterThan(0);
  });

  it("still accepts an existing block id, and reuses an id the draft carries", async () => {
    renderLog.length = 0;
    const created: string[] = [];
    function Host() {
      const handle = useDastEditor<DemoBlock, HostProps>({
        value: {
          value: {
            schema: "dast",
            document: { type: "root", children: [{ type: "paragraph", children: [] }] },
          },
          blocks: {},
        },
        blockView: BlockCard,
        blockViewProps: { edit: () => undefined, label: "host" },
        onBlockCreate: (id) => created.push(id),
      });
      return (
        <>
          <button
            type="button"
            data-testid="draft"
            onClick={() =>
              handle.commands.insertBlock({ id: "known", _type: "hero", headline: "Known" })
            }
          />
          <button
            type="button"
            data-testid="byid"
            onClick={() => handle.commands.insertBlock("missing_id")}
          />
          <EditorContent editor={handle.editor} />
        </>
      );
    }
    const container = mount(<Host />);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid=draft]")?.click());
    await flush();
    expect(created).toEqual(["known"]);
    act(() => container.querySelector<HTMLButtonElement>("[data-testid=byid]")?.click());
    await flush();
    // A string is always an existing id: no payload registered, card unresolved.
    expect(created).toEqual(["known"]);
    expect(renderLog).toContain("UNRESOLVED");
  });
});
