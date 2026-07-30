/**
 * The host's renderer for embedded blocks. `PostBlock` is the generated union
 * from `PostContentEnvelope["blocks"][string]`, so this switch is checked
 * exhaustive by the compiler — misnaming a block type is a build error.
 */
import type { BlockViewProps } from "@agent-cms/editor-react";
import type { PostContentEnvelope } from "../cms/contract.js";
import { mediaId } from "../lib/presentation.js";
import { useBlockEditing } from "./block-editing.js";

export type PostBlock = PostContentEnvelope["blocks"][string];

export function PostBlockView({ id, block, inline, remove }: BlockViewProps<PostBlock>) {
  // The only channel for host props into a blockView — see FRICTION.md #9.
  const editing = useBlockEditing();
  const editButton = (
    <button type="button" onClick={() => editing.edit(id)}>
      edit
    </button>
  );

  if (!block) {
    return (
      <span className="blockcard blockcard--missing">
        unresolved block payload
        <button type="button" onClick={remove}>
          remove
        </button>
      </span>
    );
  }

  switch (block._type) {
    case "hero_section":
      return (
        <div className={inline ? "blockcard blockcard--inline" : "blockcard"}>
          <header>
            <strong>hero_section</strong>
            {editButton}
            <button type="button" onClick={remove}>
              ×
            </button>
          </header>
          <p className="blockcard__headline">{block.headline}</p>
          {block.subheadline && <p className="muted">{block.subheadline}</p>}
          {block.background_image && (
            <p className="muted">bg: {mediaId(block.background_image)}</p>
          )}
        </div>
      );
    case "code_block":
      return (
        <div className={inline ? "blockcard blockcard--inline" : "blockcard"}>
          <header>
            <strong>code_block{block.language ? ` · ${block.language}` : ""}</strong>
            {editButton}
            <button type="button" onClick={remove}>
              ×
            </button>
          </header>
          <pre>{block.code}</pre>
        </div>
      );
    case "image_gallery":
      return (
        <div className={inline ? "blockcard blockcard--inline" : "blockcard"}>
          <header>
            <strong>image_gallery</strong>
            {editButton}
            <button type="button" onClick={remove}>
              ×
            </button>
          </header>
          <p className="muted">
            {(block.images ?? []).length} image(s){block.caption ? ` · ${block.caption}` : ""}
          </p>
        </div>
      );
    case "feature_card":
      return (
        <div className={inline ? "blockcard blockcard--inline" : "blockcard"}>
          <header>
            <strong>feature_card</strong>
            {editButton}
            <button type="button" onClick={remove}>
              ×
            </button>
          </header>
          <p className="blockcard__headline">{block.title}</p>
          {block.description && <p className="muted">{block.description}</p>}
          {/* Nested structured_text: typed only as Record<string, unknown>. */}
          {block.details && (
            <p className="muted">nested details · {Object.keys(block.details.blocks).length} block(s)</p>
          )}
        </div>
      );
    case "feature_grid":
      return (
        <div className={inline ? "blockcard blockcard--inline" : "blockcard"}>
          <header>
            <strong>feature_grid</strong>
            {editButton}
            <button type="button" onClick={remove}>
              ×
            </button>
          </header>
          <p className="blockcard__headline">{block.heading}</p>
          {block.features && (
            <p className="muted">nested features · {Object.keys(block.features.blocks).length} card(s)</p>
          )}
        </div>
      );
  }
}
