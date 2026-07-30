import { describe, expect, it } from "vitest";
import { assetSrcSet, assetUrl } from "../src/assets.ts";
import { generate } from "../src/generate.ts";
import { parseSchemaExport } from "../src/schema-types.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("assetUrl", () => {
  const asset = { url: "https://cdn.example.com/uploads/a1/photo.png" };

  it("returns the source URL unchanged when no transform is given", () => {
    expect(assetUrl(asset)).toBe(asset.url);
    expect(assetUrl(asset, {})).toBe(asset.url);
    expect(assetUrl("https://cdn.example.com/x.png")).toBe("https://cdn.example.com/x.png");
  });

  it("composes a Cloudflare Image Resizing URL at the asset's origin", () => {
    expect(assetUrl(asset, { width: 320, fit: "cover", format: "auto" })).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=320,fit=cover,format=auto/uploads/a1/photo.png",
    );
  });

  it("emits options in a deterministic order regardless of key order", () => {
    const a = assetUrl(asset, { format: "webp", width: 100, quality: 80, height: 50 });
    const b = assetUrl(asset, { height: 50, quality: 80, width: 100, format: "webp" });
    expect(a).toBe(b);
    expect(a).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=100,height=50,format=webp,quality=80/uploads/a1/photo.png",
    );
  });

  it("accepts a bare URL string as well as an asset-shaped object", () => {
    expect(assetUrl("https://cdn.example.com/uploads/a1/photo.png", { width: 10 })).toBe(
      assetUrl(asset, { width: 10 }),
    );
  });

  it("keeps the same-origin relative fallback relative", () => {
    expect(assetUrl({ url: "/assets/a1/photo.png" }, { width: 64 })).toBe(
      "/cdn-cgi/image/width=64/assets/a1/photo.png",
    );
  });

  it("escapes source paths so a filename cannot corrupt the option list", () => {
    expect(assetUrl({ url: "https://cdn.example.com/uploads/a1/my file,v2.png" }, { width: 64 })).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=64/uploads/a1/my%20file,v2.png",
    );
    expect(assetUrl({ url: "/assets/a1/my file.png" }, { width: 64 })).toBe(
      "/cdn-cgi/image/width=64/assets/a1/my%20file.png",
    );
  });

  it("escapes option values", () => {
    expect(assetUrl(asset, { background: "#ff0000/../evil" })).toBe(
      "https://cdn.example.com/cdn-cgi/image/background=%23ff0000%2F..%2Fevil/uploads/a1/photo.png",
    );
  });

  it("drops non-finite and empty options rather than emitting garbage", () => {
    expect(assetUrl(asset, { width: Number.NaN, height: Number.POSITIVE_INFINITY })).toBe(asset.url);
  });

  it("preserves the query string of the source URL", () => {
    expect(assetUrl({ url: "https://cdn.example.com/a.png?v=2" }, { width: 8 })).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=8/a.png?v=2",
    );
  });

  it("supports a focal-point gravity", () => {
    expect(assetUrl(asset, { width: 10, gravity: { x: 0.25, y: 0.75 } })).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=10,gravity=0.25x0.75/uploads/a1/photo.png",
    );
  });

  it("builds a srcSet from a width list", () => {
    expect(assetSrcSet(asset, [320, 640], { format: "auto" })).toBe(
      "https://cdn.example.com/cdn-cgi/image/width=320,format=auto/uploads/a1/photo.png 320w, " +
        "https://cdn.example.com/cdn-cgi/image/width=640,format=auto/uploads/a1/photo.png 640w",
    );
  });
});

describe("generated artifact exposes asset urls", () => {
  const schema = parseSchemaExport(
    JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/blog-schema.json", import.meta.url)), "utf8")),
  );
  const files = generate(schema);
  const contract = files["contract.ts"];

  it("AssetRecord carries a url", () => {
    expect(contract).toMatch(/export interface AssetRecord\b[\s\S]*?\burl: string;/);
  });

  it("asset write results carry a url", () => {
    expect(contract).toMatch(/export interface AssetCreateResult \{[\s\S]*?url: string;/);
    expect(contract).toMatch(/export interface AssetReplaceResult \{[\s\S]*?url: string;/);
    expect(contract).toMatch(/export interface AssetUpdateResult \{[^}]*url: string;/);
  });

  it("media reads are typed with the enriched MediaRead shape", () => {
    expect(contract).toMatch(/export interface MediaRead \{[\s\S]*?url: string;/);
    expect(contract).toContain("wire.serializable<MediaRead>()");
    // Writes stay lean: an id or a descriptor.
    expect(contract).toContain("wire.serializable<MediaValue>()");
  });

  it("media_gallery reads are arrays of MediaRead", () => {
    const raw = JSON.parse(
      readFileSync(fileURLToPath(new URL("./fixtures/blog-schema.json", import.meta.url)), "utf8"),
    );
    raw.models[0].fields.push({
      apiKey: "gallery",
      label: "Gallery",
      fieldType: "media_gallery",
      localized: false,
      validators: {},
    });
    const withGallery = generate(parseSchemaExport(raw))["contract.ts"];
    expect(withGallery).toContain("wire.serializable<MediaRead[]>()");
    expect(withGallery).toContain("wire.serializable<MediaValue[]>()");
  });

  it("seo reads carry image_url and picker rows carry imageUrl", () => {
    expect(contract).toMatch(/export interface SeoValue \{[\s\S]*?image_url\?: string \| null;/);
    expect(contract).toContain("imageUrl: string | null");
    expect(contract).toContain("imageUrl: nullableString");
  });
});
