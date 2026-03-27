import { resolve } from "node:path";

import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { runInspect } from "./commands/inspect.mjs";
import { readReport } from "./commands/report.mjs";
import { readStatus } from "./commands/status.mjs";

const defaultOutDir = resolve(process.cwd(), "scripts/dato-import/out");
const tokenOption = Options.text("dato-token").pipe(
  Options.withDescription("Dato read token. Falls back to DATOCMS_API_TOKEN."),
  Options.withDefault(process.env.DATOCMS_API_TOKEN ?? ""),
);
const cmsUrlOption = Options.text("cms-url").pipe(
  Options.withDescription("agent-cms base URL."),
  Options.withDefault(process.env.CMS_URL ?? "http://127.0.0.1:8791"),
);
const cmsWriteKeyOption = Options.text("cms-write-key").pipe(
  Options.withDescription("agent-cms write key. Falls back to CMS_WRITE_KEY."),
  Options.withDefault(process.env.CMS_WRITE_KEY ?? ""),
);
const modelOption = Options.text("model").pipe(
  Options.withDescription("Root content model to import. Optional with --from-export to import all exported models."),
  Options.withDefault(""),
);
const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Root record count. The importer expands dependencies beyond this. Ignored for whole-export imports without --model."),
  Options.withDefault(5),
);
const skipOption = Options.integer("skip").pipe(
  Options.withDescription("Root offset for slice imports."),
  Options.withDefault(0),
);
const localeOption = Options.text("locale").pipe(
  Options.withDescription("Import locale. Non-default locale passes merge localized draft values only."),
  Options.withDefault("en"),
);
const outDirOption = Options.text("out-dir").pipe(
  Options.withDescription("Directory for findings, summaries, and resumable import output."),
  Options.withDefault(defaultOutDir),
);
const exportItemChunkSizeOption = Options.integer("item-chunk-size").pipe(
  Options.withDescription("Records per exported item chunk file."),
  Options.withDefault(300),
);
const exportUploadChunkSizeOption = Options.integer("upload-chunk-size").pipe(
  Options.withDescription("Uploads per exported upload chunk file."),
  Options.withDefault(1000),
);
const exportItemConcurrencyOption = Options.integer("item-page-concurrency").pipe(
  Options.withDescription("Concurrent Dato nested item page requests during export."),
  Options.withDefault(8),
);
const exportUploadConcurrencyOption = Options.integer("upload-page-concurrency").pipe(
  Options.withDescription("Concurrent Dato upload page requests during export."),
  Options.withDefault(4),
);
const fromExportOption = Options.text("from-export").pipe(
  Options.withDescription("Path to a Dato export JSON snapshot. When set, import reads local JSON instead of CMA."),
  Options.withDefault(""),
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
}).pipe(
  Command.withDescription("Auto-generate an agent-cms schema from a DatoCMS project via CMA."),
  Command.withHandler(({ datoToken, outDir }) =>
    Effect.tryPromise(async () => {
      if (!datoToken) throw new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN.");
      const { createDatoClient } = await import("./core/datocms.mjs");
      const { generateSchema } = await import("./core/schema-codegen.mjs");
      const { ensureOutDir, writeJson } = await import("./core/runtime.mjs");
      const dato = createDatoClient({ token: datoToken });
      const schema = await generateSchema(dato);
      await ensureOutDir(outDir);
      const outPath = await writeJson(outDir, "generated-schema.json", schema);
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

const skipAssetUploadOption = Options.boolean("skip-asset-upload").pipe(
  Options.withDescription("Skip R2 asset upload, register metadata only. Useful for dry runs."),
  Options.withDefault(false),
);
const maxDepthOption = Options.integer("max-depth").pipe(
  Options.withDescription("Max recursion depth for linked record crawling. Default 3."),
  Options.withDefault(3),
);
const skipLinksOption = Options.text("skip-links").pipe(
  Options.withDescription("Comma-separated field api_keys to skip crawling (e.g. similar_tours,nearby_places). IDs are preserved but targets are not imported."),
  Options.withDefault(""),
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
}).pipe(
  Command.withDescription("Import either a thin live Dato slice or a whole pre-exported environment snapshot."),
  Command.withHandler(({ cmsUrl, cmsWriteKey, datoToken, model, limit, skip, locale, skipAssetUpload, maxDepth, skipLinks, fromExport }) => {
    if (!fromExport && !datoToken) {
      return Effect.fail(new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN."));
    }
    if (!fromExport && !model) {
      return Effect.fail(new Error("Missing model. Pass --model for live imports."));
    }
    const skipLinksList = skipLinks ? skipLinks.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return Effect.tryPromise(() => import("./core/generic-import.mjs")).pipe(
      Effect.flatMap(({ createImportProgram }) =>
        createImportProgram({ cmsUrl, cmsWriteKey, datoToken, locale, model, limit, skip, skipAssetUpload, maxDepth, skipLinks: skipLinksList, fromExport }),
      ),
    );
  }),
);

const statusCommand = Command.make("status", { outDir: outDirOption }).pipe(
  Command.withDescription("Show the latest import state snapshot and findings output."),
  Command.withHandler(({ outDir }) =>
    Effect.tryPromise(async () => {
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

const root = Command.make("dato-import").pipe(
  Command.withDescription("Import DatoCMS content into agent-cms. Auto-discovers schema, imports records with assets, links, and structured text."),
  Command.withSubcommands([inspectCommand, codegenCommand, bootstrapCommand, exportCommand, importCommand, statusCommand, reportCommand]),
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
`;
}

function statusHelp() {
  return `agent-cms dato-import status

USAGE

  npm run dato:import -- status [--out-dir <path>]
`;
}

function reportHelp() {
  return `agent-cms dato-import report

USAGE

  npm run dato:import -- report [--out-dir <path>]
`;
}
