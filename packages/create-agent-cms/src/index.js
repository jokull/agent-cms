#!/usr/bin/env node

import { execSync } from "child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join, resolve } from "path";
import { createInterface } from "readline";
import { parseArgs } from "util";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", short: "n" },
    "db-name": { type: "string" },
    "bucket-name": { type: "string" },
    "skip-prompts": { type: "boolean", short: "y", default: false },
    "local-only": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (flags.help) {
  console.log(`
  Usage: create-agent-cms [project-name] [options]

  Options:
    -n, --name          Project name (default: positional arg or "my-cms")
    --db-name           D1 database name (default: <name>-db)
    --bucket-name       R2 bucket name (default: <name>-assets)
    -y, --skip-prompts  Accept all defaults, no interactive prompts
    --local-only        Skip remote resource creation (D1/R2), local dev only
    -h, --help          Show this help

  Examples:
    npm create agent-cms my-blog
    npm create agent-cms my-blog -y
    npm create agent-cms --name my-blog --local-only
`);
  process.exit(0);
}

const isInteractive = process.stdin.isTTY && !flags["skip-prompts"];

function createAsker() {
  if (!isInteractive) return { ask: async () => "", close: () => {} };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (q) => new Promise((r) => rl.question(q, r)),
    close: () => rl.close(),
  };
}

async function prompt(ask, question, defaultValue) {
  if (!isInteractive) return defaultValue;
  const answer = (await ask(question)).trim();
  return answer || defaultValue;
}

function run(cmd, opts = {}) {
  console.log(`  $ ${cmd}`);
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
  } catch (e) {
    if (e.stderr) console.error(`    ${e.stderr.trim()}`);
    throw e;
  }
}

async function main() {
  console.log("\n  create-agent-cms\n");
  console.log("  Agent-first headless CMS on Cloudflare Workers.");
  console.log("  D1 + R2. Schema and content managed via MCP. No admin UI.\n");

  const { ask, close } = createAsker();

  const name = flags.name || positionals[0] || await prompt(ask, "  Project name (my-cms): ", "my-cms");
  const dir = resolve(name);

  if (existsSync(dir)) {
    console.error(`\n  Error: directory "${name}" already exists.\n`);
    process.exit(1);
  }

  const dbName = flags["db-name"] || await prompt(ask, `  D1 database name (${name}-db): `, `${name}-db`);
  const bucketName = flags["bucket-name"] || await prompt(ask, `  R2 bucket name (${name}-assets): `, `${name}-assets`);

  close();

  // --- Scaffold files ---

  console.log(`\n  Scaffolding ./${name}...\n`);

  mkdirSync(join(dir, "src"), { recursive: true });

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.0.1",
        private: true,
        type: "module",
        scripts: {
          dev: "wrangler dev",
          deploy: "wrangler deploy",
        },
        dependencies: {
          "agent-cms": "^0.1.0",
          wrangler: "^4.73.0",
        },
      },
      null,
      2
    )
  );

  // wrangler.jsonc — database_id will be patched after d1 create
  writeFileSync(
    join(dir, "wrangler.jsonc"),
    JSON.stringify(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        name,
        main: "src/index.ts",
        compatibility_date: "2024-12-01",
        compatibility_flags: ["nodejs_compat"],
        d1_databases: [
          {
            binding: "DB",
            database_name: dbName,
            database_id: "LOCAL_PLACEHOLDER",
          },
        ],
        r2_buckets: [
          {
            binding: "ASSETS",
            bucket_name: bucketName,
          },
        ],
        vars: {
          ENVIRONMENT: "development",
        },
      },
      null,
      2
    )
  );

  writeFileSync(
    join(dir, "src/index.ts"),
    `import { createCMSHandler, type CmsEnv } from "agent-cms";

export default {
  fetch(request: Request, env: CmsEnv): Promise<Response> {
    return createCMSHandler(env).fetch(request);
  },
};
`
  );

  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ES2022",
          moduleResolution: "bundler",
          lib: ["ES2022"],
          types: ["@cloudflare/workers-types/2023-07-01"],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          isolatedModules: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2
    )
  );

  console.log("  Files created.\n");

  // --- Install dependencies ---

  console.log("  Installing dependencies...\n");
  run("npm install", { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
  console.log("  Done.\n");

  // --- Create Cloudflare resources ---

  if (!flags["local-only"]) {
    console.log("  Creating Cloudflare resources...\n");

    // Create D1 database
    try {
      const d1Output = run(`npx wrangler d1 create ${dbName}`, { cwd: dir });
      const idMatch = d1Output.match(/database_id["\s:=]+["']?([0-9a-f-]{36})["']?/);
      if (idMatch) {
        const databaseId = idMatch[1];
        console.log(`  D1 database created: ${databaseId}\n`);
        const wranglerPath = join(dir, "wrangler.jsonc");
        const wranglerContent = readFileSync(wranglerPath, "utf-8");
        writeFileSync(wranglerPath, wranglerContent.replace("LOCAL_PLACEHOLDER", databaseId));
      }
    } catch {
      console.log(`  Warning: Could not create D1 database. Create it manually with:\n`);
      console.log(`    npx wrangler d1 create ${dbName}\n`);
    }

    // Create R2 bucket
    try {
      run(`npx wrangler r2 bucket create ${bucketName}`, { cwd: dir });
      console.log(`  R2 bucket created.\n`);
    } catch {
      console.log(`  Warning: Could not create R2 bucket. It may already exist.\n`);
    }
  }

  // --- Done ---

  console.log(`  Ready!\n`);
  console.log(`  cd ${name}`);
  console.log(`  npm run dev\n`);
  console.log(`  The database schema is created automatically on first request.\n`);
  console.log(`  Connect an MCP client:\n`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "${name}": { "url": "http://localhost:8787/mcp" }`);
  console.log(`    }`);
  console.log(`  }\n`);

  if (!flags["local-only"]) {
    console.log(`  Deploy to production:\n`);
    console.log(`    npx wrangler secret put CMS_WRITE_KEY`);
    console.log(`    npm run deploy\n`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
