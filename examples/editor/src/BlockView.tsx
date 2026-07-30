import type { BlockViewProps } from "@agent-cms/editor-react";
import type { DemoBlock } from "./blocks.js";

/**
 * The host component rendered for every embedded block/inlineBlock atom.
 * Discriminates on the payload's `_type` — a switch the compiler checks is
 * exhaustive because `DemoBlock` is a closed union.
 */
export function BlockView({ block, inline, remove }: BlockViewProps<DemoBlock>) {
  if (!block) {
    return (
      <span className="block-card block-card--missing">
        missing block payload
        <button type="button" onClick={remove}>
          remove
        </button>
      </span>
    );
  }

  switch (block._type) {
    case "hero_section":
      return (
        <div className="block-card block-card--hero">
          <img src={block.image_url} alt="" />
          <div className="block-card__body">
            <strong>{block.heading}</strong>
            <button type="button" onClick={remove}>
              remove
            </button>
          </div>
        </div>
      );
    case "cta_chip":
      return (
        <span className={inline ? "block-card block-card--cta block-card--inline" : "block-card block-card--cta"}>
          {block.label}
          <button type="button" onClick={remove}>
            ×
          </button>
        </span>
      );
  }
}
