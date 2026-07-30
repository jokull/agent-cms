/**
 * The two embedded block payload shapes this demo field allows. A real
 * project generates this union from its schema; here it's hand-written to
 * keep the demo self-contained.
 */

export interface HeroSectionBlock {
  _type: "hero_section";
  heading: string;
  image_url: string;
}

export interface CtaChipBlock {
  _type: "cta_chip";
  label: string;
}

export type DemoBlock = HeroSectionBlock | CtaChipBlock;
