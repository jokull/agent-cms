/**
 * The embedded block payloads the post.content field allows, and the host
 * component that renders + edits each one.
 *
 * The toolkit renders the host `blockView` inside a Tiptap node view (a
 * separate React tree), so this component keeps the payload in LOCAL state:
 * typing updates the form, and `props.updateBlock(id, next)` syncs the
 * authoritative envelope in the host. The collapsed wrapper header derives its
 * title/thumbnail from the generated presentation descriptor via
 * `presentRecord` — the same "default title + default thumbnail" the picker
 * table uses.
 */
import { useState, type ReactNode } from "react";
import type { BlockViewProps } from "@agent-cms/editor-react";
import {
  CODEBLOCK_PRESENTATION,
  FEATURECARD_PRESENTATION,
  FEATUREGRID_PRESENTATION,
  HEROSECTION_PRESENTATION,
  IMAGEGALLERY_PRESENTATION,
  presentRecord,
  type CodeBlockBlock,
  type FeatureCardBlock,
  type FeatureGridBlock,
  type HeroSectionBlock,
  type ImageGalleryBlock,
  type PickerRow,
} from "../cms/contract.js";
import { RecordSelect } from "./RecordSelect.jsx";

export type PostBlock =
  | HeroSectionBlock
  | CodeBlockBlock
  | ImageGalleryBlock
  | FeatureCardBlock
  | FeatureGridBlock;

export type InsertableBlock = PostBlock["_type"];

/** Host props the block cards need beyond {id, block, inline, remove}. */
export interface BlockEditing {
  readonly updateBlock: (id: string, next: PostBlock) => void;
}

const TYPE_LABELS: Record<InsertableBlock, string> = {
  hero_section: "Hero Section",
  code_block: "Code Block",
  image_gallery: "Image Gallery",
  feature_card: "Feature Card",
  feature_grid: "Feature Grid",
};

/** A fresh, EMPTY payload (DatoCMS default: a new block starts unfilled). */
export function newBlock(type: InsertableBlock): PostBlock {
  const id = crypto.randomUUID();
  switch (type) {
    case "hero_section":
      return { id, _type: "hero_section", headline: "" };
    case "code_block":
      return { id, _type: "code_block", code: "" };
    case "image_gallery":
      return { id, _type: "image_gallery" };
    case "feature_card":
      return { id, _type: "feature_card", title: "" };
    case "feature_grid":
      return { id, _type: "feature_grid", heading: "" };
  }
}

/** The generated presentation row for a block (header title + thumbnail). */
function presentBlock(block: PostBlock): PickerRow {
  switch (block._type) {
    case "hero_section":
      return presentRecord(block, HEROSECTION_PRESENTATION);
    case "code_block":
      return presentRecord(block, CODEBLOCK_PRESENTATION);
    case "image_gallery":
      return presentRecord(block, IMAGEGALLERY_PRESENTATION);
    case "feature_card":
      return presentRecord(block, FEATURECARD_PRESENTATION);
    case "feature_grid":
      return presentRecord(block, FEATUREGRID_PRESENTATION);
  }
}

/** True when the block carries no user content — drives the default collapsed state. */
function isEmpty(block: PostBlock): boolean {
  for (const [key, value] of Object.entries(block)) {
    if (key === "id" || key === "_type") continue;
    if (value !== undefined && value !== null && value !== "" && value !== false) return false;
  }
  return true;
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <label className="blk__field">
      <span className="blk__label">{label}</span>
      {children}
    </label>
  );
}

function Note({ children }: { readonly children: ReactNode }) {
  return <p className="blk__note">{children}</p>;
}

export function BlockView({ id, block, inline, remove, props }: BlockViewProps<PostBlock, BlockEditing>) {
  if (!block) {
    return (
      <div className="blk blk--missing">
        <span>Unresolved block payload</span>
        <button type="button" onClick={remove}>
          remove
        </button>
      </div>
    );
  }
  return <BlockWrapper id={id} block={block} inline={inline} remove={remove} updateBlock={props?.updateBlock} />;
}

interface BlockWrapperProps {
  readonly id: string;
  readonly block: PostBlock;
  readonly inline: boolean;
  readonly remove: () => void;
  readonly updateBlock: ((id: string, next: PostBlock) => void) | undefined;
}

function BlockWrapper({ id, block, inline, remove, updateBlock }: BlockWrapperProps) {
  const [local, setLocal] = useState<PostBlock>(block);
  // Fresh (empty) blocks start expanded; content starts collapsed.
  const [collapsed, setCollapsed] = useState<boolean>(() => !isEmpty(block));

  const update = (next: PostBlock) => {
    setLocal(next);
    updateBlock?.(id, next);
  };

  const row = presentBlock(local);
  const label = TYPE_LABELS[local._type];
  const frame = inline ? " blk--inline" : "";

  return (
    <div className={`blk blk--${local._type}${frame}${collapsed ? " blk--collapsed" : ""}`}>
      <div
        className="blk__head"
        role="button"
        tabIndex={0}
        onClick={() => setCollapsed((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") setCollapsed((value) => !value);
        }}
      >
        <span className="blk__caret" aria-hidden="true">
          {collapsed ? "▸" : "▾"}
        </span>
        {row.imageUrl !== null && <img className="blk__thumb" src={row.imageUrl} alt="" />}
        <span className="blk__type">{label}</span>
        <span className="blk__title">{row.title ?? ""}</span>
        <button
          type="button"
          className="blk__remove"
          onClick={(event) => {
            event.stopPropagation();
            remove();
          }}
        >
          remove
        </button>
      </div>

      {!collapsed && (
        <div className="blk__body">
          <BlockForm block={local} update={update} />
        </div>
      )}
    </div>
  );
}

function BlockForm({ block, update }: { readonly block: PostBlock; readonly update: (next: PostBlock) => void }) {
  switch (block._type) {
    case "hero_section":
      return (
        <div className="blk__form">
          <Field label="Headline">
            <input value={block.headline} onChange={(event) => update({ ...block, headline: event.target.value })} />
          </Field>
          <Field label="Subheadline">
            <textarea
              value={block.subheadline ?? ""}
              onChange={(event) => update({ ...block, subheadline: event.target.value })}
            />
          </Field>
          <Field label="CTA text">
            <input value={block.cta_text ?? ""} onChange={(event) => update({ ...block, cta_text: event.target.value })} />
          </Field>
          <Field label="CTA URL">
            <input value={block.cta_url ?? ""} onChange={(event) => update({ ...block, cta_url: event.target.value })} />
          </Field>
          <Field label="Author">
            <RecordSelect
              value={block.author ?? null}
              onChange={(id) => {
                if (id === null) {
                  const { author, ...rest } = block;
                  void author;
                  update(rest);
                } else {
                  update({ ...block, author: id });
                }
              }}
              title="Author"
            />
          </Field>
          <Note>Background image: media field (not editable in this demo).</Note>
        </div>
      );
    case "code_block":
      return (
        <div className="blk__form">
          <Field label="Code">
            <textarea value={block.code} onChange={(event) => update({ ...block, code: event.target.value })} />
          </Field>
          <Field label="Language">
            <input value={block.language ?? ""} onChange={(event) => update({ ...block, language: event.target.value })} />
          </Field>
          <Field label="Filename">
            <input value={block.filename ?? ""} onChange={(event) => update({ ...block, filename: event.target.value })} />
          </Field>
        </div>
      );
    case "image_gallery":
      return (
        <div className="blk__form">
          <Field label="Caption">
            <input value={block.caption ?? ""} onChange={(event) => update({ ...block, caption: event.target.value })} />
          </Field>
          <Field label="Layout">
            <input value={block.layout ?? ""} onChange={(event) => update({ ...block, layout: event.target.value })} />
          </Field>
          <Note>Images: media_gallery field (not editable in this demo).</Note>
        </div>
      );
    case "feature_card":
      return (
        <div className="blk__form">
          <Field label="Title">
            <input value={block.title} onChange={(event) => update({ ...block, title: event.target.value })} />
          </Field>
          <Field label="Description">
            <textarea
              value={block.description ?? ""}
              onChange={(event) => update({ ...block, description: event.target.value })}
            />
          </Field>
          <Note>Details: nested structured_text (not editable in this demo).</Note>
        </div>
      );
    case "feature_grid":
      return (
        <div className="blk__form">
          <Field label="Heading">
            <input value={block.heading} onChange={(event) => update({ ...block, heading: event.target.value })} />
          </Field>
          <Note>Features: nested structured_text (not editable in this demo).</Note>
        </div>
      );
  }
}
