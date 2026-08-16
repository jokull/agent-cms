import { resolve } from "node:path";

import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { runInspect } from "./commands/inspect.mjs";
import { readReport } from "./commands/report.mjs";
import { readProjectStatus, readStatus } from "./commands/status.mjs";

const defaultOutDir = resolve(process.cwd(), "scripts/dato-import/out");
const tokenOption = Flag.string("dato-token").pipe(
  Flag.withDescription("Dato read token. Falls back to DATOCMS_API_TOKEN."),
  Flag.withDefault(process.env.DATOCMS_API_TOKEN ?? ""),
);
const cmsUrlOption = Flag.string("cms-url").pipe(
  Flag.withDescription("agent-cms base URL."),
  Flag.withDefault(process.env.CMS_URL ?? "http://127.0.0.1:8791"),
);
const cmsWriteKeyOption = Flag.string("cms-write-key").pipe(
  Flag.withDescription("agent-cms write key. Falls back to CMS_WRITE_KEY."),
  Flag.withDefault(process.env.CMS_WRITE_KEY ?? ""),
);
const modelOption = Flag.string("model").pipe(
  Flag.withDescription("Root content model to import. Optional with --from-export to import all exported models."),
  Flag.withDefault(""),
);
const limitOption = Flag.integer("limit").pipe(
  Flag.withDescription("Root record count. The importer expands dependencies beyond this. Ignored for whole-export imports without --model."),
  Flag.withDefault(5),
);
const skipOption = Flag.integer("skip").pipe(
  Flag.withDescription("Root offset for slice imports."),
  Flag.withDefault(0),
);
const localeOption = Flag.string("locale").pipe(
  Flag.withDescription("Import locale. Non-default locale passes merge localized draft values only."),
  Flag.withDefault("en"),
);
const outDirOption = Flag.string("out-dir").pipe(
  Flag.withDescription("Directory for findings, summaries, and resumable import output."),
  Flag.withDefault(defaultOutDir),
);
const constantsOutOption = Flag.string("constants-out").pipe(
  Flag.withDescription("Optional TypeScript path for generated schema API-key constants."),
  Flag.withDefault(""),
);
const exportItemChunkSizeOption = Flag.integer("item-chunk-size").pipe(
  Flag.withDescription("Records per exported item chunk file."),
  Flag.withDefault(300),
);
const exportUploadChunkSizeOption = Flag.integer("upload-chunk-size").pipe(
  Flag.withDescription("Uploads per exported upload chunk file."),
  Flag.withDefault(1000),
);
const exportItemConcurrencyOption = Flag.integer("item-page-concurrency").pipe(
  Flag.withDescription("Concurrent Dato nested item page requests during export."),
  Flag.withDefault(8),
);
const exportUploadConcurrencyOption = Flag.integer("upload-page-concurrency").pipe(
  Flag.withDescription("Concurrent Dato upload page requests during export."),
  Flag.withDefault(4),
);
const fromExportOption = Flag.string("from-export").pipe(
  Flag.withDescription("Path to a Dato export JSON snapshot. When set, import reads local JSON instead of CMA."),
  Flag.withDefault(""),
);
const projectOption = Flag.string("project").pipe(
  Flag.withDescription("Dato project identifier for scoped import state."),
  Flag.withDefault(""),
);
const incrementalOption = Flag.boolean("incremental").pipe(
  Flag.withDescription("Skip records unchanged since last import (compare updated_at)."),
  Flag.withDefault(false),
);

const inspectCommand = Command.make("inspect", { datoToken: tokenOption }).pipe(
  Command.withDescription("Inspect a Dato project via CMA and write a schema summary snapshot."),
  Command.withHandler(({ datoToken }) =>
    Effect.tryPromise(async () => {
      if (!datoToken) throw new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN.");
      const { summary, outPath } = await runInspect({ token: datoToken });
      console.log("Dato inspect");
      console.log(`  site: ${summary.site.name ?? summary.site.id}`);
      console.log(`  locales: ${summary.site.locales.join(", ")}`);
      console.log(`  item types: ${summary.itemTypes.length}`);
      console.log(`Saved ${outPath}`);
    })),
);

const codegenCommand = Command.make("codegen", {
  datoToken: tokenOption,
  outDir: outDirOption,
  constantsOut: constantsOutOption,
}).pipe(
  Command.withDescription("Auto-generate an agent-cms schema from a DatoCMS project via CMA."),
  Command.withHandler(({ datoToken, outDir, constantsOut }) =>
    Effect.tryPromise(async () => {
      if (!datoToken) throw new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN.");
      const { createDatoClient } = await import("./core/datocms.mjs");
      const { generateSchema, writeSchemaConstantsModule } = await import("./core/schema-codegen.mjs");
      const { ensureOutDir, writeJson } = await import("./core/runtime.mjs");
      const dato = createDatoClient({ token: datoToken });
      const schema = await generateSchema(dato);
      await ensureOutDir(outDir);
      const outPath = await writeJson(outDir, "generated-schema.json", schema);
      if (constantsOut) {
        const constantsPath = await writeSchemaConstantsModule(constantsOut, schema);
        console.log(`Generated constants: ${constantsPath}`);
      }
      console.log(`Generated schema: ${schema.models.length} models, ${schema.locales.length} locales`);
      console.log(`  Models: ${schema.models.filter((m) => !m.isBlock).map((m) => m.apiKey).join(", ")}`);
      console.log(`  Blocks: ${schema.models.filter((m) => m.isBlock).map((m) => m.apiKey).join(", ")}`);
      console.log(`Saved ${outPath}`);
    })),
);

const bootstrapCommand = Command.make("bootstrap", {
  cmsUrl: cmsUrlOption,
  cmsWriteKey: cmsWriteKeyOption,
  datoToken: tokenOption,
}).pipe(
  Command.withDescription("Auto-generate schema from Dato and import it into agent-cms via schema_io."),
  Command.withHandler(({ cmsUrl, cmsWriteKey, datoToken }) =>
    Effect.tryPromise(async () => {
      if (!datoToken) throw new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN.");
      const { createDatoClient } = await import("./core/datocms.mjs");
      const { generateSchema } = await import("./core/schema-codegen.mjs");
      const { createAgentCmsClient } = await import("./core/agent-cms.mjs");

      // Generate schema from Dato
      const dato = createDatoClient({ token: datoToken });
      const schema = await generateSchema(dato);
      console.log(`Generated schema: ${schema.models.length} models, ${schema.locales.length} locales`);

      // Import into agent-cms via schema_io
      const cms = createAgentCmsClient({ cmsUrl });
      const response = await cms.json("POST", "/api/schema", schema);
      console.log(`Schema imported into ${cmsUrl}`);
      console.log(`  Created: ${JSON.stringify(response)}`);
    })),
);

const exportCommand = Command.make("export", {
  datoToken: tokenOption,
  outDir: outDirOption,
  itemChunkSize: exportItemChunkSizeOption,
  uploadChunkSize: exportUploadChunkSizeOption,
  itemPageConcurrency: exportItemConcurrencyOption,
  uploadPageConcurrency: exportUploadConcurrencyOption,
}).pipe(
  Command.withDescription("Export a whole Dato environment to local JSON using paginated nested item reads."),
  Command.withHandler(({ datoToken, outDir, itemChunkSize, uploadChunkSize, itemPageConcurrency, uploadPageConcurrency }) =>
    Effect.tryPromise(async () => {
      if (!datoToken) throw new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN.");
      const { exportDatoEnvironment } = await import("./core/export-snapshot.mjs");
      const { outPath, snapshot } = await exportDatoEnvironment({
        token: datoToken,
        outDir,
        itemChunkSize,
        uploadChunkSize,
        itemPageConcurrency,
        uploadPageConcurrency,
      });
      console.log("Dato export");
      console.log(`  records: ${snapshot.counts.records}`);
      console.log(`  models: ${snapshot.counts.models}`);
      console.log(`  uploads: ${snapshot.counts.uploads}`);
      console.log(`Saved ${outPath}`);
    })),
);

const skipAssetUploadOption = Flag.boolean("skip-asset-upload").pipe(
  Flag.withDescription("Skip R2 asset upload, register metadata only. Useful for dry runs."),
  Flag.withDefault(false),
);
const maxDepthOption = Flag.integer("max-depth").pipe(
  Flag.withDescription("Max recursion depth for linked record crawling. Default 3."),
  Flag.withDefault(3),
);
const skipLinksOption = Flag.string("skip-links").pipe(
  Flag.withDescription("Comma-separated field api_keys to skip crawling (e.g. similar_tours,nearby_places). IDs are preserved but targets are not imported."),
  Flag.withDefault(""),
);

const importCommand = Command.make("import", {
  cmsUrl: cmsUrlOption,
  cmsWriteKey: cmsWriteKeyOption,
  datoToken: tokenOption,
  model: modelOption,
  limit: limitOption,
  skip: skipOption,
  locale: localeOption,
  skipAssetUpload: skipAssetUploadOption,
  maxDepth: maxDepthOption,
  skipLinks: skipLinksOption,
  fromExport: fromExportOption,
  project: projectOption,
  incremental: incrementalOption,
}).pipe(
  Command.withDescription("Import either a thin live Dato slice or a whole pre-exported environment snapshot."),
  Command.withHandler(({ cmsUrl, cmsWriteKey, datoToken, model, limit, skip, locale, skipAssetUpload, maxDepth, skipLinks, fromExport, project, incremental }) => {
    if (!fromExport && !datoToken) {
      return Effect.fail(new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN."));
    }
    if (!fromExport && !model) {
      return Effect.fail(new Error("Missing model. Pass --model for live imports."));
    }
    const skipLinksList = skipLinks ? skipLinks.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return Effect.tryPromise(() => import("./core/generic-import.mjs")).pipe(
      Effect.flatMap(({ createImportProgram }) =>
        createImportProgram({ cmsUrl, cmsWriteKey, datoToken, locale, model, limit, skip, skipAssetUpload, maxDepth, skipLinks: skipLinksList, fromExport, project, incremental }),
      ),
    );
  }),
);

const statusCommand = Command.make("status", { outDir: outDirOption, project: projectOption }).pipe(
  Command.withDescription("Show the latest import state snapshot and findings output."),
  Command.withHandler(({ outDir, project }) =>
    Effect.tryPromise(async () => {
      if (project) {
        const { recordCounts, assetCounts, referencedPending, latestRun, activeRun } = readProjectStatus(outDir, project);

        console.log(`Import State: ${project}`);

        if (latestRun) {
          const date = new Date(latestRun.started_at + "Z").toLocaleString();
          const modelInfo = latestRun.model_api_key ? `, ${latestRun.model_api_key}` : "";
          console.log(`Last run: ${date} (${latestRun.mode}${modelInfo})`);
        } else {
          console.log("Last run: none");
        }

        console.log("");

        const rImported = fmt(recordCounts.imported ?? 0);
        const rSkipped = fmt(recordCounts.skipped ?? 0);
        const rPending = fmt(recordCounts.pending ?? 0);
        const rFailed = fmt(recordCounts.failed ?? 0);
        console.log(`Records:  ${rImported} imported / ${rSkipped} skipped / ${rPending} pending / ${rFailed} failed`);

        const aImported = fmt(assetCounts.imported ?? 0);
        const aSkipped = fmt(assetCounts.skipped ?? 0);
        const aPending = fmt(assetCounts.pending ?? 0);
        const aFailed = fmt(assetCounts.failed ?? 0);
        console.log(`Assets:   ${aImported} imported / ${aSkipped} skipped / ${aPending} pending / ${aFailed} failed`);
        console.log(`          Priority queue: ${fmt(referencedPending)} referenced by imported records`);

        if (activeRun) {
          console.log("");
          console.log(`Active run: ${activeRun.mode} (started ${timeAgo(activeRun.started_at + "Z")})`);
          console.log(`  Imported: ${fmt(activeRun.records_imported)} records, ${fmt(activeRun.assets_imported)} assets`);
        }

        return;
      }

      const status = await readStatus(outDir);
      console.log(`Out dir: ${status.outDir}`);
      if (!status.latestCheckpoint && !status.latestFindings) {
        console.log("No import output found.");
        return;
      }
      if (status.latestCheckpoint) {
        console.log(`Latest checkpoint: ${status.latestCheckpoint.name}`);
        console.log(`  Path: ${status.latestCheckpoint.path}`);
        if (status.latestCheckpoint.value?.status) {
          console.log(`  Status: ${status.latestCheckpoint.value.status}`);
        }
      }
      if (status.latestFindings) {
        console.log(`Latest findings: ${status.latestFindings.name}`);
        console.log(`  Path: ${status.latestFindings.path}`);
      }
    })),
);

function fmt(n) {
  return n.toLocaleString();
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

const reportCommand = Command.make("report", { outDir: outDirOption }).pipe(
  Command.withDescription("Summarize the latest findings JSON emitted by the importer."),
  Command.withHandler(({ outDir }) =>
    Effect.tryPromise(async () => {
      const report = await readReport(outDir);
      console.log(`Out dir: ${report.outDir}`);
      if (!report.latest || !report.summary) {
        console.log("No findings report found.");
        return;
      }
      console.log(`Latest: ${report.latest.name}`);
      console.log(`Findings: ${report.summary.total}`);
      for (const [type, count] of Object.entries(report.summary.byType)) {
        console.log(`  ${type}: ${count}`);
      }
    })),
);

const assetImportCommand = Command.make("asset-import", {
  cmsUrl: cmsUrlOption,
  cmsWriteKey: cmsWriteKeyOption,
  project: projectOption,
  concurrency: Flag.integer("concurrency").pipe(
    Flag.withDescription("Concurrent asset imports."),
    Flag.withDefault(6),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Count pending assets without importing."),
    Flag.withDefault(false),
  ),
  outDir: outDirOption,
}).pipe(
  Command.withDescription("Import queued assets by priority. Run after record import to fill R2."),
  Command.withHandler(({ cmsUrl, cmsWriteKey, project, concurrency, dryRun, outDir }) => {
    if (!project) return Effect.fail(new Error("Missing --project. Required for asset import state."));
    return Effect.tryPromise(() =>
      import("./commands/asset-import.mjs").then(({ runAssetImport }) =>
        runAssetImport({ cmsUrl, cmsWriteKey, project, concurrency, dryRun, outDir })
      )
    );
  }),
);

const root = Command.make("dato-import").pipe(
  Command.withDescription("Import DatoCMS content into agent-cms. Auto-discovers schema, imports records with assets, links, and structured text."),
  Command.withSubcommands([inspectCommand, codegenCommand, bootstrapCommand, exportCommand, importCommand, statusCommand, reportCommand, assetImportCommand]),
);

const helpText = buildHelp(process.argv.slice(2));
if (helpText) {
  console.log(helpText);
  process.exit(0);
}

const run = Command.run(root, {
  name: "agent-cms dato-import",
  version: "0.2.0",
  summary:
    "Integrity-first Dato import tooling for agent-cms. Auto-discovers schema from DatoCMS CMA. Thin root slices expand to full dependency closure; assets copy directly to R2.",
  footer: "",
});

NodeRuntime.runMain(run(process.argv));

function buildHelp(args) {
  if (!args.includes("--help") && !args.includes("-h")) {
    return null;
  }

  const command = args.find((arg) => !arg.startsWith("-"));
  if (command === "inspect") return inspectHelp();
  if (command === "codegen") return codegenHelp();
  if (command === "bootstrap") return bootstrapHelp();
  if (command === "export") return exportHelp();
  if (command === "import") return importHelp();
  if (command === "status") return statusHelp();
  if (command === "report") return reportHelp();
  if (command === "asset-import") return assetImportHelp();
  return rootHelp();
}

function rootHelp() {
  return `agent-cms dato-import

Import DatoCMS content into agent-cms. Auto-discovers schema from CMA.

The requested root slice is not the final row count:
- linked records are crawled automatically
- StructuredText block references are crawled automatically
- nested StructuredText dependencies are crawled automatically
- assets are copied directly to R2, then registered in agent-cms

USAGE

  npm run dato:import -- <command> [options]

COMMANDS

  inspect      Inspect a Dato project via CMA and write a schema snapshot
  codegen      Auto-generate an agent-cms schema from a DatoCMS project
  bootstrap    Generate schema from Dato and import it into agent-cms
  export       Export a whole Dato environment to local JSON
  import       Import a live slice or a local export snapshot
  asset-import Import queued assets by priority (run after record import)
  status       Show the latest output path for an import run
  report       Summarize the latest findings JSON

GLOBAL ENV

  DATOCMS_API_TOKEN    Dato read token
  CMS_URL              agent-cms base URL (default: http://127.0.0.1:8791)
  CMS_WRITE_KEY        agent-cms write key
`;
}

function inspectHelp() {
  return `agent-cms dato-import inspect

USAGE

  npm run dato:import -- inspect [--dato-token <token>]
`;
}

function codegenHelp() {
  return `agent-cms dato-import codegen

Auto-generate an agent-cms ImportSchemaInput from a DatoCMS project.

USAGE

  npm run dato:import -- codegen [--dato-token <token>] [--out-dir <path>]
    [--constants-out <path>]
`;
}

function bootstrapHelp() {
  return `agent-cms dato-import bootstrap

Generate schema from Dato CMA and import into agent-cms via schema_io.

USAGE

  npm run dato:import -- bootstrap [--cms-url <url>] [--dato-token <token>]
`;
}

function exportHelp() {
  return `agent-cms dato-import export

USAGE

  npm run dato:import -- export [--dato-token <token>] [--out-dir <path>]
    [--item-chunk-size <n>] [--upload-chunk-size <n>]
    [--item-page-concurrency <n>] [--upload-page-concurrency <n>]
`;
}

function importHelp() {
  return `agent-cms dato-import import

USAGE

  npm run dato:import -- import --model <apiKey> [options]
  npm run dato:import -- import --from-export <path> [--model <apiKey>] [options]

OPTIONS

  --project <id>   Dato project identifier. When set, assets are enqueued in an
                   SQLite priority queue instead of imported immediately.
  --incremental    Skip records whose source updated_at hasn't changed since the
                   last import. Compares against destination timestamps. Requires
                   --project for tracking skipped records in state store.
`;
}

function statusHelp() {
  return `agent-cms dato-import status

USAGE

  npm run dato:import -- status [--out-dir <path>] [--project <id>]

OPTIONS

  --project <id>   Show rich SQLite state (record/asset counts, active run) for a project.
                   Without --project, falls back to file-based checkpoint output.
`;
}

function reportHelp() {
  return `agent-cms dato-import report

USAGE

  npm run dato:import -- report [--out-dir <path>]
`;
}

function assetImportHelp() {
  return `agent-cms dato-import asset-import

Import queued assets by priority. Run after record import to fill R2.
Assets are checked for existence before importing (GET check skips already-imported).

USAGE

  npm run dato:import -- asset-import --project <id> [options]

OPTIONS

  --project <id>        Dato project identifier for scoped import state (required)
  --cms-url <url>       agent-cms base URL (default: CMS_URL or http://127.0.0.1:8791)
  --cms-write-key <key> agent-cms write key (default: CMS_WRITE_KEY)
  --concurrency <n>     Concurrent asset imports (default: 6)
  --dry-run             Count pending assets without importing
  --out-dir <path>      Directory for import state (default: scripts/dato-import/out)
`;
}
