import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generate } from "../src/generate.ts";
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
    // The contract is a fragment builder over the host's RpcFactory<C>, not its
    // own `rpc.context`, and mutations merge the host's `mutationErrors`.
    expect(files["contract.ts"]).toContain(
      "export function cmsContract<C, MErrors extends ErrorDefinitionMap>("
    );
    expect(files["contract.ts"]).toContain("return { post, author, siteSettings, navItem, assets };");
    expect(files["contract.ts"]).not.toContain("rpc.context");
    // procedures are a factory the host spreads into its own router.
    expect(files["procedures.ts"]).toContain("export function cmsProcedures<C,");
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
    expect(contract).toContain("filter: wire.optional(wire.serializable<PostFilter>()),");
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
});
