/**
 * The demo server: a plain Node process (no wrangler, no D1, no R2) that runs
 * agent-cms's Effect services in-process against a SQLite file, mounts the
 * generated CMS fragments + a host procedure into ONE result-rpc router, and
 * serves both the RPC endpoint and the built SPA.
 *
 *   pnpm build && pnpm start   →  http://localhost:8790
 */
import { createServer, type IncomingMessage } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { cmsRuntimeLayer, ensureSchema, SchemaIO } from "agent-cms/lib";
import { ok } from "result-rpc";
import { createFetchHandler, createServerClient, serverRpc } from "result-rpc/server";
import { cms, contract, serverInfoContract, type HostContext } from "../src/contract.js";
import { cmsProcedures } from "../src/cms/procedures.js";

const PORT = Number(process.env.PORT ?? 8790);
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const DB_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.demo/blocks-editor.db");

void contract;

// --- CMS runtime: a SQLite layer, no D1 binding ---
await mkdir(dirname(DB_FILE), { recursive: true });
const sqlLayer = SqliteClient.layer({ filename: DB_FILE }).pipe(Layer.orDie);
await Effect.runPromise(ensureSchema().pipe(Effect.provide(sqlLayer)));
// Register the schema (models + fields + content tables) from schema.json —
// only on first boot; the DB persists across restarts.
const schemaJson = await readFile(
  resolve(dirname(fileURLToPath(import.meta.url)), "../schema.json"),
  "utf8",
);
const hasModels = await Effect.runPromise(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<{ n: number }>("SELECT COUNT(*) AS n FROM models");
    return (rows[0]?.n ?? 0) > 0;
  }).pipe(Effect.provide(sqlLayer)),
);
if (!hasModels) {
  await Effect.runPromise(SchemaIO.importSchema(JSON.parse(schemaJson)).pipe(Effect.provide(cmsRuntimeLayer(sqlLayer))));
}

// --- result-rpc router: CMS fragments + a host procedure, one contract ---
const VIEWER = { id: "demo", name: "Demo Editor" };
const server = serverRpc.context<HostContext>();

/** No auth gate — the demo's mutations always run. Pass-through middleware. */
const passThrough = server
  .middleware<{}>()
  .errors({})
  .use(async ({ next }) => next({ context: {} }));

const router = server.router({
  cms: cmsProcedures(server, cms, {
    layer: sqlLayer,
    actor: () => ({ type: "editor", label: VIEWER.id }),
    mutationMiddleware: passThrough,
  }),
  host: {
    serverInfo: server.implement(serverInfoContract).handler(async () =>
      ok({ stack: "agent-cms + result-rpc + sqlite", modelCount: 1 }),
    ),
  },
});

const rpcHandler = createFetchHandler({
  router,
  endpoint: "/rpc",
  createContext: (): HostContext => ({ viewer: VIEWER }),
});

// --- Seed authors + one post (through the real procedure path) if empty ---
const seedClient = createServerClient(router, { context: { viewer: VIEWER } });
{
  // Authors first: the hero block links to one.
  let heroAuthorId: string | null = null;
  const existingAuthors = await seedClient.cms.author.list({});
  if (existingAuthors.isOk() && existingAuthors.value.total > 0) {
    heroAuthorId = existingAuthors.value.records[0]?.id ?? null;
  } else {
    const seedNames = [
      { name: "Ada Lovelace", role: "Mathematician" },
      { name: "Grace Hopper", role: "Computer scientist" },
      { name: "Edsger Dijkstra", role: "Computer scientist" },
    ];
    for (const data of seedNames) {
      const created = await seedClient.cms.author.create({ data });
      if (created.isOk() && heroAuthorId === null) heroAuthorId = created.value.id;
    }
    console.log("seeded 3 authors");
  }

  const existing = await seedClient.cms.post.list({});
  if (existing.isOk() && existing.value.total === 0) {
    await seedClient.cms.post.create({
      data: {
        title: "Blocks, assembled",
        slug: "blocks-assembled",
        excerpt: "A demo post showing embedded blocks in a custom DAST editor.",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                {
                  type: "heading",
                  level: 1,
                  children: [{ type: "span", value: "Blocks, assembled" }],
                },
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "span",
                      value: "Type / anywhere to insert a heading, list, table, or an embedded component.",
                    },
                  ],
                },
                { type: "block", item: "hero-1" },
                {
                  type: "paragraph",
                  children: [
                    { type: "span", value: "Below is an embedded code block:" },
                  ],
                },
                { type: "block", item: "code-1" },
              ],
            },
          },
          blocks: {
            "hero-1": {
              id: "hero-1",
              _type: "hero_section",
              headline: "A hero section, living inside structured text",
              subheadline: "Embedded blocks are first-class DAST citizens.",
              cta_text: "Learn more",
              cta_url: "https://result-rpc.com",
              ...(heroAuthorId !== null ? { author: heroAuthorId } : {}),
            },
            "code-1": {
              id: "code-1",
              _type: "code_block",
              code: 'const message = "hello from a block";',
              language: "ts",
              filename: "hello.ts",
            },
          },
        },
      },
    });
    console.log("seeded 1 post");
  }
}

// --- HTTP: /rpc → fetch handler, everything else → dist/ (SPA fallback) ---
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function readBodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function nodeHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

async function handleRpc(req: IncomingMessage): Promise<Response> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBodyText(req);
  return rpcHandler(
    new Request(url, {
      method: req.method,
      headers: nodeHeaders(req.headers),
      body,
    }),
  );
}

function serveStatic(pathname: string): Promise<Response> {
  const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  let filePath = resolve(DIST, safe === "/" ? "index.html" : safe.slice(1));
  if (!filePath.startsWith(DIST)) return Promise.resolve(new Response("forbidden", { status: 403 }));
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, "index.html");
  if (!existsSync(filePath)) {
    // SPA fallback: any non-asset path serves index.html.
    const fallback = extname(filePath) === "" ? join(DIST, "index.html") : null;
    filePath = fallback ?? filePath;
  }
  if (!existsSync(filePath)) return Promise.resolve(new Response("not found", { status: 404 }));
  return readFile(filePath).then(
    (content) =>
      new Response(new Uint8Array(content), {
        headers: { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" },
      }),
  );
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const respond = (response: Response) =>
    Promise.resolve(response)
      .then(async (r) => {
        res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
        res.end(new Uint8Array(await r.arrayBuffer()));
      })
      .catch((error: unknown) => {
        console.error("request failed", error);
        res.writeHead(500);
        res.end("internal error");
      });

  if (url.pathname === "/rpc") {
    handleRpc(req).then(respond, respond);
    return;
  }
  serveStatic(url.pathname).then(respond, respond);
});

httpServer.listen(PORT, () => {
  console.log(`blocks-editor → http://localhost:${PORT}  (RPC at /rpc, SPA from ${DIST})`);
});

function onSignal() {
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
