# Deployment Patterns

agent-cms supports two deployment architectures. Pick based on your team size and whether the CMS serves multiple consumers.

## Pattern A: Separate Workers (service binding)

```
┌─────────────────┐     service binding      ┌──────────────────┐
│   Site Worker    │ ◄──── env.CMS.fetch ───► │   CMS Worker     │
│   (Astro/Hono)  │      (zero latency)      │   (agent-cms)    │
│                  │                          │                  │
│   KV, etc.      │                          │   D1, R2, AI     │
└─────────────────┘                          └──────────────────┘
```

**wrangler.jsonc (site):**
```jsonc
{
  "services": [{ "binding": "CMS", "service": "my-cms-worker" }]
}
```

**Usage:**
```typescript
const res = await env.CMS.fetch("http://cms/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query, variables }),
});
const { data } = await res.json();
```

**Tradeoffs:**
- Independent deploys, versioning, and cold starts
- CMS can serve multiple consumers
- JSON serialization round-trip per query (~2-5ms)
- Two Workers to manage

**Best for:** Multi-site setups, teams with separate frontend/CMS ownership.

## Pattern B: Single Worker (in-process execute)

```
┌──────────────────────────────────────────┐
│              Single Worker               │
│                                          │
│   Site (Astro/Hono)                      │
│     └─► cms.execute(query, vars)         │
│           └─► GraphQL schema (cached)    │
│               └─► D1 queries             │
│                                          │
│   /cms/* catch-all → cms.fetch()         │
│   (GraphiQL, MCP, REST API)              │
│                                          │
│   Bindings: D1, R2, KV, AI, Vectorize   │
└──────────────────────────────────────────┘
```

**Setup:**

```typescript
// src/lib/cms.ts
import { createCMSHandler } from "agent-cms";

let cached: ReturnType<typeof createCMSHandler> | null = null;

export function getCms(env: Env) {
  if (!cached) {
    cached = createCMSHandler({
      bindings: {
        db: env.DB,
        assets: env.ASSETS,
        ai: env.AI,
        vectorize: env.VECTORIZE,
      },
    });
  }
  return cached;
}

// In your page/loader:
const cms = getCms(env);
const { data } = await cms.execute(`{ allPosts { id title slug } }`, undefined, {
  includeDrafts: false,
});
```

**Expose CMS HTTP endpoints for external tools (Astro catch-all):**

```typescript
// src/pages/cms/[...path].ts
import type { APIRoute } from "astro";
import { getCms } from "../../lib/cms";

const handler: APIRoute = async ({ request, locals }) => {
  const url = new URL(request.url);
  const cmsPath = url.pathname.replace(/^\/cms/, "") || "/";
  const cmsRequest = new Request(new URL(cmsPath + url.search, url.origin), request);
  return getCms(locals.runtime.env).fetch(cmsRequest);
};

export const GET = handler;
export const POST = handler;
export const PATCH = handler;
export const DELETE = handler;
export const PUT = handler;
```

**Tradeoffs:**
- Zero serialization overhead from `execute()`
- One Worker, one deploy, one set of bindings
- Larger bundle (site + agent-cms + Effect)
- Coupled deploys

**Best for:** Solo projects, small teams, single-consumer sites.

## Typed queries with gql.tada

Both patterns can use [gql.tada](https://gql-tada.0no.co/) for type-safe queries:

```typescript
import { graphql, type ResultOf } from "gql.tada";
import { print } from "graphql";

const AllPostsQuery = graphql(`
  query AllPosts {
    allPosts { id title slug publishedAt }
  }
`);

type Posts = ResultOf<typeof AllPostsQuery>;

// Pattern B (in-process):
const { data } = await cms.execute(print(AllPostsQuery));

// Pattern A (service binding):
const res = await env.CMS.fetch("http://cms/graphql", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: print(AllPostsQuery) }),
});
```

gql.tada needs a `graphql-schema.graphql` SDL file. Generate it via introspection:

```bash
# Using any GraphQL introspection tool:
npx gql.tada generate-schema --url http://localhost:8787/graphql -o graphql-schema.graphql
```

Introspection queries are exempt from depth/complexity limits, so standard introspection tools work out of the box.
