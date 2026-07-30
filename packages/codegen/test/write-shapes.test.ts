/**
 * Type-level proof that read-modify-write compiles against the generated
 * contract (FRICTION #1 / #5): what `post.byId` hands back must drop straight
 * into `post.update`, and every update field must accept `null` to clear it.
 *
 * These are compile-time assertions — `pnpm exec tsc --noEmit` is the real
 * assertion; the runtime `expect`s just keep vitest honest about the file being
 * exercised. Types come from the checked-in example contract, which the package
 * tsconfig compiles.
 */
import { describe, expect, it } from "vitest";
import {
  METRICSAMPLE_PRESENTATION,
  POST_PRESENTATION,
  PRESENTATION,
  presentRecord,
} from "../example/generated/contract.ts";
import type {
  DastDocument,
  MetricSample,
  PickerRow,
  HeroSectionBlock,
  Post,
  PostContentEnvelope,
  PostContentWrite,
  UpdatePost,
} from "../example/generated/contract.ts";

const doc: DastDocument = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "span", value: "hi", marks: ["strong", "customMark_kbd"] }] },
      { type: "block", item: "blk_1" },
    ],
  },
};

const hero: HeroSectionBlock = { id: "blk_1", _type: "hero_section", heading: "Hello" };

// What a read gives you.
const readEnvelope: PostContentEnvelope = { value: doc, blocks: { blk_1: hero } };

describe("generated write shapes accept read shapes", () => {
  it("a read envelope is assignable to the field's write type", () => {
    const write: PostContentWrite = readEnvelope;
    expect(Object.keys(write.blocks ?? {})).toEqual(["blk_1"]);
  });

  it("a whole record read round-trips into Update<Model> with no adapter", () => {
    // The exact move the proof app had to write a 70-line adapter for.
    const fromRead: Pick<Post, "content" | "title"> = { content: readEnvelope, title: "t" };
    const patch: UpdatePost = { title: fromRead.title, content: fromRead.content };
    expect(patch.title).toBe("t");
  });

  it("a raw block payload object is still accepted on write", () => {
    const patch: UpdatePost = {
      content: { value: doc, blocks: { blk_1: { _type: "hero_section", heading: "raw" } } },
    };
    expect(patch.content).toBeDefined();
  });

  it("custom marks survive: the editor's DAST is the contract's DAST", () => {
    const marks = doc.document.children[0]?.type === "paragraph"
      ? doc.document.children[0].children[0]
      : undefined;
    expect(marks && "marks" in marks ? marks.marks : []).toContain("customMark_kbd");
  });
});

describe("update inputs accept null to clear a field", () => {
  it("every field type takes null, and absent stays absent", () => {
    const clearAll: UpdatePost = {
      title: null,
      slug: null,
      excerpt: null,
      featured: null,
      published_at: null,
      tier: null,
      content: null,
      authors: null,
      cover: null,
      seo: null,
    };
    expect(Object.values(clearAll).every((v) => v === null)).toBe(true);

    const untouched: UpdatePost = {};
    expect("title" in untouched).toBe(false);
  });

  it("a localized field can be cleared per locale", () => {
    const perLocale: UpdatePost = { excerpt: { en: null, is: "hallo" } };
    expect(perLocale.excerpt).toEqual({ en: null, is: "hallo" });
  });
});

describe("presentRecord renders a row generically from the descriptor", () => {
  const record: Post = {
    id: "rec_1",
    status: "published",
    createdAt: null,
    updatedAt: "2026-07-30T10:00:00.000Z",
    publishedAt: null,
    title: "Hello world",
    slug: "hello-world",
    excerpt: null,
    featured: null,
    published_at: null,
    tier: null,
    content: null,
    authors: null,
    cover: {
      upload_id: "asset_1",
      url: "https://cdn.example.com/a.jpg",
      filename: "a.jpg",
      mime_type: "image/jpeg",
      size: 10,
      width: 1,
      height: 1,
      alt: null,
      title: null,
      focal_point: null,
      custom_data: null,
      blurhash: null,
    },
    seo: null,
  };

  it("produces the same row shape picker search returns", () => {
    const row: PickerRow = presentRecord(record, POST_PRESENTATION);
    expect(row).toEqual({
      id: "rec_1",
      title: "Hello world",
      image: "asset_1",
      imageUrl: "https://cdn.example.com/a.jpg",
      status: "published",
      updatedAt: "2026-07-30T10:00:00.000Z",
    });
  });

  it("falls back to the record id when the model has no title field", () => {
    const sample: MetricSample = {
      id: "m_1",
      status: "draft",
      createdAt: null,
      updatedAt: null,
      publishedAt: null,
      value: 1.5,
      captured_at: null,
    };
    expect(presentRecord(sample, METRICSAMPLE_PRESENTATION)).toEqual({
      id: "m_1",
      title: "m_1",
      image: null,
      imageUrl: null,
      status: "draft",
      updatedAt: null,
    });
  });

  it("reads the registry by api_key and takes the first image of a gallery", () => {
    expect(PRESENTATION.press_mention.title).toBe("subject");
    const gallery = [
      { upload_id: "g1", url: "https://cdn.example.com/g1.jpg" },
      { upload_id: "g2", url: "https://cdn.example.com/g2.jpg" },
    ];
    const row = presentRecord({ id: "p_1", subject: "Bang", photo: gallery }, PRESENTATION.press_mention);
    expect([row.image, row.imageUrl]).toEqual(["g1", "https://cdn.example.com/g1.jpg"]);
  });
});
