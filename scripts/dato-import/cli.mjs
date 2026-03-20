import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as Command from "@effect/cli/Command";
import * as Options from "@effect/cli/Options";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Effect } from "effect";

import { runInspect } from "./commands/inspect.mjs";
import { readReport } from "./commands/report.mjs";
import { readStatus } from "./commands/status.mjs";

const defaultOutDir = resolve(process.cwd(), "scripts/dato-import/out/trip");
const tokenOption = Options.text("dato-token").pipe(
  Options.withDescription("Dato read token. Falls back to DATOCMS_API_TOKEN."),
  Options.withDefault(process.env.DATOCMS_API_TOKEN ?? ""),
);
const cmsUrlOption = Options.text("cms-url").pipe(
  Options.withDescription("agent-cms base URL."),
  Options.withDefault(process.env.CMS_URL ?? "http://127.0.0.1:8791"),
);
const adapterOption = Options.choice("adapter", ["trip"]).pipe(
  Options.withDescription("Import adapter. 'trip' is the currently proven large fixture."),
  Options.withDefault("trip"),
);
const modelOption = Options.text("model").pipe(Options.withDescription("Root content model to import."));
const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Root record count. The importer expands dependencies beyond this."),
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

const bootstrapCommand = Command.make("bootstrap", {
  adapter: adapterOption,
  cmsUrl: cmsUrlOption,
  datoToken: tokenOption,
  locale: localeOption,
}).pipe(
  Command.withDescription("Bootstrap an agent-cms schema for a Dato import adapter."),
  Command.withHandler(({ adapter, cmsUrl, datoToken, locale }) => {
    if (!datoToken) {
      return Effect.fail(new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN."));
    }
    return Effect.tryPromise(() =>
      importWithEnv(
        resolve(process.cwd(), `scripts/dato-import/adapters/${adapter}/bootstrap.mjs`),
      ),
    ).pipe(
      Effect.flatMap(({ createBootstrapProgram }) => createBootstrapProgram({ cmsUrl, datoToken, locale })),
    );
  }),
);

const importCommand = Command.make("import", {
  adapter: adapterOption,
  cmsUrl: cmsUrlOption,
  datoToken: tokenOption,
  model: modelOption,
  limit: limitOption,
  skip: skipOption,
  locale: localeOption,
}).pipe(
  Command.withDescription("Import a thin Dato root slice and expand it to a referentially intact local closure."),
  Command.withHandler(({ adapter, cmsUrl, datoToken, model, limit, skip, locale }) => {
    if (!datoToken) {
      return Effect.fail(new Error("Missing Dato token. Pass --dato-token or set DATOCMS_API_TOKEN."));
    }
    return Effect.tryPromise(() =>
      importWithEnv(
        resolve(process.cwd(), `scripts/dato-import/adapters/${adapter}/import.mjs`),
      ),
    ).pipe(
      Effect.flatMap(({ createImportProgram }) => createImportProgram({ cmsUrl, datoToken, locale, model, limit, skip })),
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
  Command.withDescription("Import DatoCMS content into agent-cms with explicit setup, resumable runs, and direct-to-R2 assets."),
  Command.withSubcommands([inspectCommand, bootstrapCommand, importCommand, statusCommand, reportCommand]),
);

const helpText = buildHelp(process.argv.slice(2));
if (helpText) {
  console.log(helpText);
  process.exit(0);
}

const run = Command.run(root, {
  name: "agent-cms dato-import",
  version: "0.1.0",
  summary:
    "Integrity-first Dato import tooling for agent-cms. Thin root slices expand to full dependency closure; assets copy directly to R2 and are then registered in agent-cms.",
  footer: "",
});

NodeRuntime.runMain(run(process.argv));

async function importWithEnv(modulePath) {
  return import(pathToFileURL(modulePath).href);
}

function buildHelp(args) {
  if (!args.includes("--help") && !args.includes("-h")) {
    return null;
  }

  const command = args.find((arg) => !arg.startsWith("-"));
  if (command === "inspect") return inspectHelp();
  if (command === "bootstrap") return bootstrapHelp();
  if (command === "import") return importHelp();
  if (command === "status") return statusHelp();
  if (command === "report") return reportHelp();
  return rootHelp();
}

function rootHelp() {
  return `agent-cms dato-import

Integrity-first Dato import tooling for agent-cms.

The requested root slice is not the final row count:
- linked records are crawled automatically
- StructuredText block references are crawled automatically
- nested StructuredText dependencies are crawled automatically
- assets are copied directly to R2, then registered in agent-cms

USAGE

  npm run dato:import -- <command> [options]

COMMANDS

  inspect      Inspect a Dato project via CMA and write a schema snapshot
  bootstrap    Bootstrap an agent-cms schema for a Dato import adapter
  import       Import a thin root slice and expand to dependency closure
  status       Show the latest output path for an import run
  report       Summarize the latest findings JSON

GLOBAL ENV

  DATOCMS_API_TOKEN    Dato read token
  CMS_URL              agent-cms base URL (default: http://127.0.0.1:8791)
  IMPORT_LOCALE        Locale for adapter-backed import runs (default: en)
`;
}

function inspectHelp() {
  return `agent-cms dato-import inspect

USAGE

  npm run dato:import -- inspect [--dato-token <token>]
`;
}

function bootstrapHelp() {
  return `agent-cms dato-import bootstrap

USAGE

  npm run dato:import -- bootstrap --adapter trip [--cms-url <url>] [--dato-token <token>] [--locale <code>]
`;
}

function importHelp() {
  return `agent-cms dato-import import

USAGE

  npm run dato:import -- import --adapter trip --model <apiKey> [options]
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
