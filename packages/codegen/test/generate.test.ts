import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate, resolvePresentation } from "../src/generate.ts";
import { parseSchemaExport } from "../src/schema-types.ts";
import fixture from "./fixtures/blog-schema.json" with { type: "json" };

const exampleDir = join(import.meta.dirname, "..", "example", "generated");

describe("generate", () => {
  it("is deterministic and the checked-in example is fresh", async () => {
    const files = generate(parseSchemaExport(fixture));
    expect(generate(parseSchemaExport(fixture))).toEqual(files);
    expect(await readFile(join(exampleDir, "contract.ts"), "utf8")).toBe(files["contract.ts"]);
    expect(await readFile(join(exampleDir, "procedures.ts"), "utf8")).toBe(files["procedures.ts"]);
  });

  it("emits host-generic fragment builders, not a self-contained app", () => {
    const files = generate(parseSchemaExport(fixture));
    // The contract is a fragment builder over the host's browser-safe
    // ContractFactory<C>, not its own `rpc.context`. The host's mutation errors
    // arrive as a concrete import from the scaffolded host-errors.ts rather than
    // a type parameter — result-rpc's compatibility constraints only evaluate
    // against a concrete map.
    expect(files["contract.ts"]).toContain("export function cmsContract<C>(app: ContractFactory<C>) {");
    expect(files["contract.ts"]).toContain('import { mutationErrors } from "./host-errors.js";');
    expect(files["contract.ts"]).toContain(
      "return { post, author, siteSettings, navItem, landingPage, pressMention, metricSample, assets };",
    );
    expect(files["contract.ts"]).not.toContain("rpc.context");
    // procedures are a factory the host spreads into its own router.
    expect(files["procedures.ts"]).toContain("export function cmsProcedures<C>(");
    expect(files["procedures.ts"]).toContain("@agent-cms/codegen/server-runtime");
    expect(files["procedures.ts"]).not.toContain("createCmsRestExecutor");
  });

  it("declares ticket-07 per-op failure unions (no cms/conflict)", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    expect(contract).toContain('.errors(pickErrors(cmsErrors, "schemaDrift")).query()'); // list → drift
    expect(contract).toContain('pickErrors(cmsErrors, "recordNotFound", "schemaDrift")'); // byId
    expect(contract).toContain('pickErrors(cmsErrors, "validationFailed", "duplicate", "schemaDrift")'); // create
    expect(contract).toContain('pickErrors(cmsErrors, "recordNotFound", "referenceConflict", "schemaDrift")'); // delete
    expect(contract).toContain(".errors(mutationErrors)"); // host auth merges into mutations
    expect(contract).not.toContain('"conflict"'); // the merged REST tag is gone
  });

  it("emits a block union from the structured_text whitelist", () => {
    const files = generate(parseSchemaExport(fixture));
    expect(files["contract.ts"]).toContain("Record<string, HeroSectionBlock | CtaBlockBlock>");
    expect(files["contract.ts"]).toContain('_type: "hero_section"');
  });

  it("emits the full per-model CRUD surface (WS-D)", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    // New per-model procedures beyond byId/create/update/delete/publish/unpublish.
    for (const op of ["search:", "duplicate:", "publishMany:", "unpublishMany:", "deleteMany:", "links:", "validate:", "validateUpdate:", "syncState:", "schedulePublish:", "scheduleUnpublish:", "clearSchedule:"]) {
      expect(contract, op).toContain(`      ${op}`);
    }
    // Nested versions group.
    expect(contract).toContain("      versions: {");
    expect(contract).toContain("        restore: app.procedure().input(wire.object({ id: wire.string, versionId: wire.string }))");
    // list is now a filtered page, not a bare array.
    expect(contract).toContain("output(wire.object({ records: wire.array(PostCodec), total: wire.integer() }))");
  });

  it("emits a typed per-model filter interface and orderBy union", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    expect(contract).toContain("export interface PostFilter {");
    expect(contract).toContain("title?: StringFilter;");
    // enum field carries its literal union into the filter operator type.
    expect(contract).toContain('tier?: StringFilter<"free" | "member" | "premium">;');
    expect(contract).toContain("authors?: LinksFilter;");
    expect(contract).toContain("featured?: BooleanFilter;");
    // localized model gets a _locales filter; AND/OR nest recursively.
    expect(contract).toContain("_locales?: LocalesFilter;");
    expect(contract).toContain("AND?: readonly PostFilter[];");
    // carried as a serializable (server re-validates); not a nested wire codec.
    expect(contract).toContain(
      'filter: wire.optional(wire.serializable<PostFilter>(guard.isFilter, { id: "agent-cms/filter.post@1" })),',
    );
    expect(contract).toContain('export type PostOrderBy =');
    expect(contract).toContain('"title_ASC"');
    expect(contract).toContain('"_createdAt_DESC"');
  });

  it("special-cases singleton models (get/update, no collection surface)", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    const procedures = generate(parseSchemaExport(fixture))["procedures.ts"];
    // Singleton emits get + a get-const the mutations affect, not a list.
    expect(contract).toContain("const siteSettingsGet = app.procedure().output(SiteSettingsCodec)");
    expect(contract).toContain(".affects(siteSettingsGet).mutation()");
    expect(procedures).toContain("get: app.implement(contract.siteSettings.get)");
    expect(procedures).toContain("cms.getSingleton(\"site_settings\")");
    expect(procedures).toContain("cms.updateSingleton(\"site_settings\"");
    // No collection procedures for a singleton.
    expect(contract).not.toContain("const siteSettingsList");
    expect(procedures).not.toContain("cms.duplicate(\"site_settings\"");
  });

  it("gates reorder on sortable/tree models only", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    const procedures = generate(parseSchemaExport(fixture))["procedures.ts"];
    // nav_item is sortable → reorder; post is not.
    expect(contract).toContain("reorder: app.procedure().input(IdsInput)");
    expect(procedures).toContain("cms.reorder(\"nav_item\"");
    // post gets no reorder.
    expect(procedures).not.toContain("cms.reorder(\"post\"");
  });

  it("emits a shared assets namespace (one, not per-model)", () => {
    const files = generate(parseSchemaExport(fixture));
    const contract = files["contract.ts"];
    const procedures = files["procedures.ts"];
    for (const op of ["list:", "get:", "createUploadUrl:", "create:", "importFromUrl:", "update:", "replace:", "delete:", "usages:"]) {
      expect(procedures, `assets.${op}`).toContain(`contract.assets.${op.slice(0, -1)}`);
    }
    // reference-conflict declared on asset delete (force-guard 409).
    expect(contract).toContain('pickErrors(cmsErrors, "recordNotFound", "referenceConflict")');
    expect(procedures).toContain("cms.assetsDelete(input.id, input.force ?? false)");
  });

  it("carries issues[].code through the validation-failed codec (errors module)", async () => {
    const errors = await readFile(join(import.meta.dirname, "..", "src", "errors.ts"), "utf8");
    expect(errors).toContain("code: wire.optional(wire.string),");
  });

  it("maps validators to types: required, enum, localized", () => {
    const files = generate(parseSchemaExport(fixture));
    // required string stays bare; optional fields union with null on output
    expect(files["contract.ts"]).toContain("title: wire.string,");
    expect(files["contract.ts"]).toContain(
      'tier: wire.union([wire.union([wire.literal("free"), wire.literal("member"), wire.literal("premium")] as const), wire.null] as const)'
    );
    // localized wraps in wire.record
    expect(files["contract.ts"]).toContain("excerpt: wire.union([wire.record(wire.string), wire.null] as const)");
  });

  it("imports DAST from @agent-cms/dast instead of inlining a fourth copy", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    expect(contract).toContain('} from "@agent-cms/dast";');
    expect(contract).toContain("  BlockLevelNode as DastBlockLevelNode,");
    expect(contract).toContain("  BlockNode as DastBlockRefNode,");
    // the old vendored declarations are gone…
    expect(contract).not.toContain("export interface DastSpanNode {");
    expect(contract).not.toContain("export interface DastDocument {");
    // …but the historical names are still exported for consumers.
    expect(contract).toContain("export type {");
    expect(contract).toContain("  DastDocument,");
    // browser-safety: the only value imports are result-rpc + the errors module.
    const valueImports = contract.match(/^import (?!type )[^\n]*$/gm) ?? [];
    expect(valueImports).toEqual([
      'import { pickErrors, wire, type ContractFactory, type ErrorDefinitionMap, type InputOf } from "result-rpc";',
      'import * as guard from "@agent-cms/codegen/guards";',
      'import { cmsErrors } from "@agent-cms/codegen/errors";',
      'import { mutationErrors } from "./host-errors.js";',
    ]);
    expect(contract).not.toContain('from "agent-cms');
  });

  it("emits a per-field structured_text write alias the read envelope satisfies", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    expect(contract).toContain(
      "export type PostContentWrite = StructuredTextWrite<HeroSectionBlock | CtaBlockBlock | Record<string, unknown>>;"
    );
    expect(contract).toContain("export interface StructuredTextWrite<TBlock = Record<string, unknown>> {");
    expect(contract).toContain("  blocks?: Readonly<Record<string, TBlock>>;");
    expect(contract).toContain("content: wire.optional(wire.union([wire.serializable<PostContentWrite>(guard.isStructuredTextWrite,");
  });

  describe("presentation descriptors (ADR 0006 / FRICTION #2)", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];

    it("emits a typed descriptor per model plus an api_key-keyed registry", () => {
      expect(contract).toContain("export interface ModelPresentation {");
      expect(contract).toContain("export function presentRecord<T extends { id: string }>(");
      expect(contract).toContain(
        'export const POST_PRESENTATION = {\n  model: "post",\n  title: "title",\n  image: "cover",\n} as const satisfies ModelPresentation;',
      );
      expect(contract).toContain("export const PRESENTATION = {");
      expect(contract).toContain('  "post": POST_PRESENTATION,');
      // Blocks get one too — a block card is a row.
      expect(contract).toContain('  "hero_section": HEROSECTION_PRESENTATION,');
    });

    it("prefers the model's explicit hints over any guess", () => {
      // landing_page has a `title` field and a `hero_shot` media field, but
      // declares title_field=seo_label / image_preview_field=secondary_shot.
      expect(contract).toContain(
        'export const LANDINGPAGE_PRESENTATION = {\n  model: "landing_page",\n  title: "seo_label",\n  image: "secondary_shot",\n} as const satisfies ModelPresentation;',
      );
    });

    it("falls back in a fixed order when the model carries no hints", () => {
      const byKey = new Map(
        parseSchemaExport(fixture).models.map((model) => [model.apiKey, resolvePresentation(model)]),
      );
      // conventional name wins over field order (post.title, author.name, nav_item.label)
      expect(byKey.get("post")).toEqual({ title: "title", image: "cover" });
      expect(byKey.get("author")).toEqual({ title: "name", image: "avatar" });
      // no conventional name → first REQUIRED string (subject), not the first string (code)
      expect(byKey.get("press_mention")).toEqual({ title: "subject", image: "photo" });
      // site_settings has neither a conventional name nor a required-string race:
      // its only string field is required, so it is both.
      expect(byKey.get("site_settings")).toEqual({ title: "site_title", image: "logo" });
      // no string field at all → null title; no media field → null image
      expect(byKey.get("metric_sample")).toEqual({ title: null, image: null });
      expect(byKey.get("nav_item")).toEqual({ title: "label", image: null });
    });

    it("falls back to the first string field when none is required", () => {
      const model = {
        name: "Loose",
        apiKey: "loose",
        isBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        hasDraft: true,
        ordering: null,
        canonicalPathTemplate: null,
        fields: [
          { label: "Note", apiKey: "note", fieldType: "text", position: 2, localized: false, validators: {}, hint: null },
          { label: "Ref", apiKey: "ref", fieldType: "slug", position: 1, localized: false, validators: {}, hint: null },
        ],
      };
      expect(resolvePresentation(model)).toEqual({ title: "ref", image: null });
    });

    it("ignores a hint naming a field that does not exist", () => {
      const model = {
        name: "Stale",
        apiKey: "stale",
        isBlock: false,
        singleton: false,
        sortable: false,
        tree: false,
        hasDraft: true,
        ordering: null,
        canonicalPathTemplate: null,
        titleField: "gone",
        imagePreviewField: "also_gone",
        fields: [
          { label: "Name", apiKey: "name", fieldType: "string", position: 1, localized: false, validators: {}, hint: null },
        ],
      };
      expect(resolvePresentation(model)).toEqual({ title: "name", image: null });
    });
  });

  it("makes every update field nullable (null clears, absent leaves unchanged)", () => {
    const contract = generate(parseSchemaExport(fixture))["contract.ts"];
    const update = contract.slice(
      contract.indexOf("export const PostUpdateInput = wire.object({"),
      contract.indexOf("export type UpdatePost =")
    );
    // required-on-create `title` is still nullable on update
    expect(update).toContain("title: wire.optional(wire.union([wire.string, wire.null] as const)),");
    expect(update).toContain("authors: wire.optional(wire.union([wire.array(wire.string), wire.null] as const)),");
    // localized fields are nullable per locale AND as a whole
    expect(update).toContain(
      "excerpt: wire.optional(wire.union([wire.record(wire.union([wire.string, wire.null] as const)), wire.null] as const)),"
    );
    // create inputs are unchanged: optional, not nullable
    expect(contract).toContain("export const PostCreateInput = wire.object({\n  title: wire.string,");
  });
});
