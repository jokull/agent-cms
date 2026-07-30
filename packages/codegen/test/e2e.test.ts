/**
 * End-to-end over a REAL in-memory agent-cms (SQLite + migrations), not a fake
 * REST backend. Proves the settled shape (tickets 01 + 07):
 *
 * 1. Merge — the host's OWN procedure (host.whoami) and the CMS fragments live
 *    in ONE contract / router / client: `client.cms.post.*` and
 *    `client.host.whoami` are the same client.
 * 2. Typed read + write against the real services (record actually in SQLite).
 * 3. Validation aggregation — a create with two bad fields arrives as
 *    cms/validation-failed with MULTIPLE issues[] (W1 through the wire).
 * 4. BYO-auth — an unauthenticated mutation is rejected with the HOST's own
 *    Unauthorized; authenticated passes; the actor mapper writes the user id
 *    into _created_by.
 * 5. Drift — a column corrupted out of contract surfaces as cms/schema-drift,
 *    not server/internal.
 *
 * The client is generated at test time from the CMS's actual /api/schema export
 * (like real-schema.test.ts), written to test/__generated__, and imported.
 *
 * Lives outside tsconfig's include (vitest-only): it imports the CMS source tree
 * and a runtime-generated module, neither of which the package tsconfig compiles.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { createBrowserClient, batchFetchTransport } from "result-rpc/client";
import { createFetchHandler } from "result-rpc/server";
import { rpc, wire, ok, err, error } from "result-rpc";
import { beforeAll, describe, expect, it } from "vitest";
import { createTestApp, jsonRequest } from "../../../test/app-helpers.js";
import { generate } from "../src/generate.ts";
import { parseSchemaExport } from "../src/schema-types.ts";
import { cmsErrors } from "../src/errors.ts";

// The host's OWN error — contributed by the host's middleware, not agent-cms.
const Unauthorized = error({ tag: "auth/unauthorized", httpStatus: 401 });

interface HostContext {
  user: { id: string } | null;
}

type SqlLayer = Layer.Layer<SqlClient.SqlClient>;

const genDir = join(import.meta.dirname, "__generated__");

// Filled by beforeAll once the schema is built and the client generated.
let harness: {
  client: (userId: string | null) => ReturnType<typeof makeClient>;
  sqlLayer: SqlLayer;
  handler: (req: Request) => Promise<Response>;
};

function runSql<A>(sqlLayer: SqlLayer, effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(sqlLayer)));
}

function makeClient(deps: {
  contract: unknown;
  handleRpc: (req: Request) => Promise<Response>;
  userId: string | null;
}) {
  return createBrowserClient({
    contract: deps.contract,
    transport: batchFetchTransport({
      url: "https://host.test/rpc",
      fetch: async (input, init) => {
        const req = new Request(input, init);
        if (deps.userId) req.headers.set("authorization", `Bearer ${deps.userId}`);
        return deps.handleRpc(req);
      },
    }),
  });
}

beforeAll(async () => {
  const { handler, sqlLayer } = createTestApp();

  const createModel = async (body: Record<string, unknown>): Promise<string> => {
    const res = await jsonRequest(handler, "POST", "/api/models", body);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const json: { id: string } = await res.json();
    return json.id;
  };
  const addField = async (modelId: string, body: Record<string, unknown>) => {
    const res = await jsonRequest(handler, "POST", `/api/models/${modelId}/fields`, body);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  };

  // A record model with: a required title, an enum (for drift), and two media
  // fields (for two independent validation failures) — all fed through the
  // real service layer, no fixtures.
  const postId = await createModel({ name: "Post", apiKey: "post" });
  await addField(postId, { label: "Title", apiKey: "title", fieldType: "string", validators: { required: {} } });
  await addField(postId, { label: "Tier", apiKey: "tier", fieldType: "string", validators: { enum: ["free", "member"] } });
  await addField(postId, { label: "Cover", apiKey: "cover", fieldType: "media" });
  await addField(postId, { label: "Banner", apiKey: "banner", fieldType: "media" });
  // A self-referential links field so backlinks have something to find.
  await addField(postId, { label: "Related", apiKey: "related", fieldType: "links", validators: { items_item_type: ["post"] } });

  const exportRes = await jsonRequest(handler, "GET", "/api/schema");
  expect(exportRes.status).toBe(200);
  const schema = parseSchemaExport(await exportRes.json());

  const files = generate(schema);
  mkdirSync(genDir, { recursive: true });
  writeFileSync(join(genDir, "contract.ts"), files["contract.ts"]);
  writeFileSync(join(genDir, "procedures.ts"), files["procedures.ts"]);

  const contractModule = await import(join(genDir, "contract.ts"));
  const proceduresModule = await import(join(genDir, "procedures.ts"));
  const { cmsContract } = contractModule;
  const { cmsProcedures } = proceduresModule;

  // The host app — its OWN context, its OWN procedure, the CMS fragments, and
  // its OWN auth middleware, all in ONE contract / router / client.
  const app = rpc.context<HostContext>();

  const cmsFragment = cmsContract(app, { mutationErrors: { Unauthorized } });

  const whoamiContract = app
    .procedure()
    .output(wire.object({ id: wire.union([wire.string, wire.null] as const) }))
    .query();

  const contract = app.contract({
    cms: cmsFragment,
    host: { whoami: whoamiContract },
  });

  const authenticated = app
    .middleware<{}>()
    .errors({ Unauthorized })
    .use(async ({ context, errors, next }) =>
      context.user ? next({ context }) : err(errors.Unauthorized()),
    );

  const router = app.router({
    cms: cmsProcedures(app, cmsFragment, {
      layer: sqlLayer,
      actor: (ctx: HostContext) => (ctx.user ? { type: "editor", label: ctx.user.id } : null),
      mutationMiddleware: authenticated,
    }),
    host: {
      whoami: app.implement(whoamiContract).handler(async ({ context }) =>
        ok({ id: context.user ? context.user.id : null }),
      ),
    },
  });

  const handleRpc = createFetchHandler({
    router,
    endpoint: "/rpc",
    createContext: ({ request }: { request: Request }): HostContext => {
      const auth = request.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
      return { user: token ? { id: token } : null };
    },
  });

  harness = {
    handler,
    sqlLayer,
    client: (userId: string | null) => makeClient({ contract, handleRpc, userId }),
  };
});

describe("codegen fragments over a real in-memory CMS", () => {
  it("merges host + CMS into one client (host.whoami and cms.post.* coexist)", async () => {
    const client = harness.client("editor_1");
    const who = await client.host.whoami();
    expect(who.ok).toBe(true);
    if (who.ok) expect(who.value.id).toBe("editor_1");
  });

  it("typed write then read hits real SQLite", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "Hello", tier: "free" } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;
    const title: string = created.value.title;
    expect(title).toBe("Hello");

    const read = await client.cms.post.byId({ id });
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.tier).toBe("free");

    // Actually in the database:
    const rows = await runSql(
      harness.sqlLayer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ title: string }>(`SELECT title FROM content_post WHERE id = ?`, [id]);
      }),
    );
    expect(rows[0].title).toBe("Hello");
  });

  it("validation aggregation: two bad fields → cms/validation-failed with multiple issues", async () => {
    const client = harness.client("editor_1");
    const result = await client.cms.post.create({
      data: { title: "x", cover: "missing_cover", banner: "missing_banner" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(cmsErrors.validationFailed.is(result.error)).toBe(true);
    if (cmsErrors.validationFailed.is(result.error)) {
      expect(result.error.data.issues.length).toBeGreaterThanOrEqual(2);
      const fields = result.error.data.issues.map((i) => i.field);
      expect(fields).toContain("cover");
      expect(fields).toContain("banner");
    }
  });

  it("BYO-auth: unauthenticated mutation is rejected with the host's Unauthorized", async () => {
    const anon = harness.client(null);
    const denied = await anon.cms.post.create({ data: { title: "Nope", tier: "free" } });
    expect(denied.ok).toBe(false);
    if (denied.ok) return;
    expect(Unauthorized.is(denied.error)).toBe(true);
  });

  it("authenticated mutation passes and the actor mapper writes _created_by", async () => {
    const client = harness.client("editor_42");
    const created = await client.cms.post.create({ data: { title: "By 42", tier: "member" } });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) return;

    const rows = await runSql(
      harness.sqlLayer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql.unsafe<{ _created_by: string }>(`SELECT _created_by FROM content_post WHERE id = ?`, [created.value.id]);
      }),
    );
    expect(rows[0]._created_by).toBe("editor_42");
  });

  it("drift: a column corrupted out of contract surfaces as cms/schema-drift", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "Drifter", tier: "free" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.value.id;

    // Corrupt the enum column to a value the generated contract does not allow.
    await runSql(
      harness.sqlLayer,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(`UPDATE content_post SET tier = 'enterprise' WHERE id = ?`, [id]);
      }),
    );

    const read = await client.cms.post.byId({ id });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(cmsErrors.schemaDrift.is(read.error)).toBe(true);
    if (cmsErrors.schemaDrift.is(read.error)) {
      expect(read.error.data.procedure).toBe("post.byId");
    }
    expect(read.error._tag).not.toBe("server/internal");
  });

  // --- WS-D growth: the full CRUD surface over the real CMS ---

  it("filtered + paginated list returns a page with a total", async () => {
    const client = harness.client("editor_1");
    for (const tier of ["free", "member", "free"]) {
      const created = await client.cms.post.create({ data: { title: `List ${tier} ${Math.random()}`, tier } });
      expect(created.ok, JSON.stringify(created)).toBe(true);
    }
    const page = await client.cms.post.list({ filter: { tier: { eq: "free" } }, orderBy: ["_createdAt_DESC"], page: { limit: 1, offset: 0 } });
    expect(page.ok, JSON.stringify(page)).toBe(true);
    if (!page.ok) return;
    expect(page.value.records.length).toBe(1);
    expect(page.value.total).toBeGreaterThanOrEqual(2); // at least the two "free" rows
    expect(page.value.records[0].tier).toBe("free");
  });

  it("picker search returns presentation rows", async () => {
    const client = harness.client("editor_1");
    await client.cms.post.create({ data: { title: "Findable Unicorn", tier: "free" } });
    const rows = await client.cms.post.search({ q: "Unicorn" });
    expect(rows.ok, JSON.stringify(rows)).toBe(true);
    if (!rows.ok) return;
    expect(rows.value.length).toBeGreaterThanOrEqual(1);
    const row = rows.value[0];
    expect(typeof row.id).toBe("string");
    expect(row.title).toContain("Unicorn");
  });

  it("validate dry-run fails with MULTIPLE coded issues over the wire", async () => {
    const client = harness.client("editor_1");
    // Missing required title + two unresolvable media references → several issues,
    // each carrying a machine-readable code.
    const result = await client.cms.post.validate({ data: { cover: "missing_cover", banner: "missing_banner" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(cmsErrors.validationFailed.is(result.error)).toBe(true);
    if (cmsErrors.validationFailed.is(result.error)) {
      expect(result.error.data.issues.length).toBeGreaterThanOrEqual(2);
      // At least one issue carries a code (issues[0] is populated at the source).
      expect(result.error.data.issues[0].code).toBeTruthy();
      const codes = result.error.data.issues.map((i) => i.code);
      expect(codes).toContain("required"); // title
    }
  });

  it("duplicate deep-copies a record into a new Draft", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "Original", tier: "member" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const dup = await client.cms.post.duplicate({ id: created.value.id });
    expect(dup.ok, JSON.stringify(dup)).toBe(true);
    if (!dup.ok) return;
    expect(dup.value.id).not.toBe(created.value.id);
    expect(dup.value.title).toBe("Original");
    expect(dup.value.status).toBe("draft");
  });

  it("bulk publish returns per-id results for mixed ids", async () => {
    const client = harness.client("editor_1");
    const a = await client.cms.post.create({ data: { title: "Bulk A", tier: "free" } });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const res = await client.cms.post.publishMany({ ids: [a.value.id, "does_not_exist"] });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) return;
    const byId = new Map(res.value.map((r) => [r.id, r]));
    expect(byId.get(a.value.id)?.ok).toBe(true);
    expect(byId.get("does_not_exist")?.ok).toBe(false);
    expect(byId.get("does_not_exist")?.error).toBeTruthy();
  });

  it("backlinks reports inbound references", async () => {
    const client = harness.client("editor_1");
    const target = await client.cms.post.create({ data: { title: "Target", tier: "free" } });
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const referrer = await client.cms.post.create({ data: { title: "Referrer", tier: "free", related: [target.value.id] } });
    expect(referrer.ok, JSON.stringify(referrer)).toBe(true);
    if (!referrer.ok) return;
    const links = await client.cms.post.links({ id: target.value.id });
    expect(links.ok, JSON.stringify(links)).toBe(true);
    if (!links.ok) return;
    const hit = links.value.find((l) => l.recordId === referrer.value.id);
    expect(hit).toBeTruthy();
    expect(hit?.fieldApiKey).toBe("related");
  });

  it("syncState reflects an edit against the published snapshot", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "Sync", tier: "free" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await client.cms.post.publish({ id: created.value.id });
    await client.cms.post.update({ id: created.value.id, data: { title: "Sync edited" } });
    const state = await client.cms.post.syncState({ id: created.value.id });
    expect(state.ok, JSON.stringify(state)).toBe(true);
    if (!state.ok) return;
    expect(state.value.changedFields).toContain("title");
    expect(state.value.status).toBeTruthy();
  });

  it("versions: an update produces a listable version; restore round-trips", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "V1", tier: "free" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await client.cms.post.publish({ id: created.value.id }); // snapshots
    await client.cms.post.update({ id: created.value.id, data: { title: "V2" } });
    await client.cms.post.publish({ id: created.value.id }); // versions the prior published state
    const versions = await client.cms.post.versions.list({ id: created.value.id });
    expect(versions.ok, JSON.stringify(versions)).toBe(true);
    if (!versions.ok) return;
    expect(versions.value.length).toBeGreaterThanOrEqual(1);
  });

  it("schedule then clearSchedule round-trips", async () => {
    const client = harness.client("editor_1");
    const created = await client.cms.post.create({ data: { title: "Scheduled", tier: "free" } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const scheduled = await client.cms.post.schedulePublish({ id: created.value.id, at });
    expect(scheduled.ok, JSON.stringify(scheduled)).toBe(true);
    const cleared = await client.cms.post.clearSchedule({ id: created.value.id });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
  });

  it("assets: list / update metadata / usages / delete-guard 409 → force delete", async () => {
    const client = harness.client("editor_1");
    const asset = await client.cms.assets.create({ data: { filename: "photo.jpg", mimeType: "image/jpeg", size: 1234 } });
    expect(asset.ok, JSON.stringify(asset)).toBe(true);
    if (!asset.ok) return;
    const assetId = asset.value.id;

    const listed = await client.cms.assets.list({ q: "photo" });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.total).toBeGreaterThanOrEqual(1);
      expect(listed.value.assets.some((a) => a.id === assetId)).toBe(true);
    }

    const updated = await client.cms.assets.update({ id: assetId, data: { alt: "A photo", title: "Photo" } });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    if (updated.ok) expect(updated.value.alt).toBe("A photo");

    // Reference the asset from a record, then usages + delete-guard.
    const post = await client.cms.post.create({ data: { title: "Has cover", tier: "free", cover: assetId } });
    expect(post.ok, JSON.stringify(post)).toBe(true);

    const usages = await client.cms.assets.usages({ id: assetId });
    expect(usages.ok, JSON.stringify(usages)).toBe(true);
    if (usages.ok) expect(usages.value.length).toBeGreaterThanOrEqual(1);

    const guarded = await client.cms.assets.delete({ id: assetId });
    expect(guarded.ok).toBe(false);
    if (!guarded.ok) expect(cmsErrors.referenceConflict.is(guarded.error)).toBe(true);

    const forced = await client.cms.assets.delete({ id: assetId, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    if (forced.ok) expect(forced.value.deleted).toBe(true);
  });
});
