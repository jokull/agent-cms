import { Effect, Layer } from "effect";
import { SqlClient } from "@effect/sql";
import { streamText, tool, convertToModelMessages, stepCountIs } from "ai";
import type { UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod/v4";
import * as ModelService from "../services/model-service.js";
import * as FieldService from "../services/field-service.js";
import * as RecordService from "../services/record-service.js";
import * as PublishService from "../services/publish-service.js";
import * as AssetService from "../services/asset-service.js";
import * as SchemaIO from "../services/schema-io.js";
import * as StructuredTextService from "../services/structured-text-service.js";
import * as SearchService from "../search/search-service.js";
import type { VectorizeContext } from "../search/vectorize-context.js";
import type { HooksContext } from "../hooks.js";
import { ulid } from "ulidx";

type FullLayer = Layer.Layer<SqlClient.SqlClient | VectorizeContext | HooksContext>;

/**
 * Strip the field:locale: scope prefix from a block ID if present.
 * patchRecord re-scopes all IDs via scopeStructuredTextIds, so we need
 * to pass unscoped IDs to avoid double-prefixing.
 */
function unscopeBlockId(id: string, fieldApiKey: string, locale: string): string {
  const prefix = `${fieldApiKey}:${locale}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function run<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient | VectorizeContext | HooksContext>, layer: FullLayer): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
}

function getDisplayTitle(record: Record<string, unknown>, fallback: string): string {
  const title = record.title ?? record.name ?? record.heading;
  if (typeof title === "string" && title.length > 0) return title;
  if (title && typeof title === "object") {
    const localized = title as Record<string, unknown>;
    const english: unknown = localized.en;
    if (typeof english === "string" && english.length > 0) return english;
    const first = Object.values(localized).find((value): value is string => typeof value === "string" && value.length > 0);
    if (first) return first;
  }
  return fallback;
}

const SYSTEM_PROMPT = `You are a CMS content editor. Use your tools to make changes — don't ask for permission.

The ACTIVE RECORD section below has the record_id, model_api_key, field definitions, and current content.

For structured_text fields, the current content is shown as markdown below. When you rewrite it using update_structured_text, follow the same markdown format. Block sentinels like <!-- cms:block:ID --> MUST be on their own line with blank lines around them — they represent embedded content (images, etc).

Internal links: to link to other CMS records in structured text, use [link text](itemLink:RECORD_ID) syntax. Call find_linkable_content FIRST to get real record IDs, THEN call update_structured_text with those IDs embedded in the markdown. Never use placeholder IDs.

IMPORTANT: When one tool's output is needed as input to another, you MUST call them in separate steps. Do NOT call find_linkable_content and update_structured_text in the same step.`;

export function createChatHandler(
  fullLayer: FullLayer,
  options: { ai: unknown; r2Bucket?: R2Bucket; model?: string }
): (request: Request) => Promise<Response> {
  const workersai = createWorkersAI({ binding: options.ai } as Parameters<typeof createWorkersAI>[0]);
  const model = workersai(options.model ?? "@cf/meta/llama-4-scout-17b-16e-instruct");

  function createTools(currentRecordId?: string) {
    return {
    schema_info: tool({
      description: "Get the full CMS schema including all models, fields, and locales.",
      inputSchema: z.object({}),
      execute: async () => {
        console.info("[chat] tool:schema_info");
        return run(SchemaIO.exportSchema(), fullLayer);
      },
    }),

    describe_model: tool({
      description: "Get detailed information about a specific model and its fields.",
      inputSchema: z.object({
        api_key: z.string().describe("The model's api_key"),
      }),
      execute: async ({ api_key }: { api_key: string }) => {
        console.info("[chat] tool:describe_model", { api_key });
        const modelRow = await run(ModelService.getModelByApiKey(api_key), fullLayer);
        const fields = await run(FieldService.listFields(modelRow.id), fullLayer);
        return { model: modelRow, fields };
      },
    }),

    query_records: tool({
      description: "List all records for a given model.",
      inputSchema: z.object({
        model_api_key: z.string().describe("The model's api_key"),
      }),
      execute: async ({ model_api_key }: { model_api_key: string }) => {
        console.info("[chat] tool:query_records", { model_api_key });
        return run(RecordService.listRecords(model_api_key), fullLayer);
      },
    }),

    get_record: tool({
      description: "Get a single record by ID, including all field values.",
      inputSchema: z.object({
        model_api_key: z.string().describe("The model's api_key"),
        record_id: z.string().describe("The record ID"),
      }),
      execute: async ({ model_api_key, record_id }: { model_api_key: string; record_id: string }) => {
        console.info("[chat] tool:get_record", { model_api_key, record_id });
        return run(RecordService.getRecord(model_api_key, record_id), fullLayer);
      },
    }),

    create_record: tool({
      description: "Create a new record in the specified model.",
      inputSchema: z.object({
        model_api_key: z.string().describe("The model's api_key"),
        data: z.record(z.string(), z.unknown()).describe("Field values keyed by field api_key"),
      }),
      execute: async ({ model_api_key, data }: { model_api_key: string; data: Record<string, unknown> }) => {
        console.info("[chat] tool:create_record", { model_api_key, data });
        return run(RecordService.createRecord({ modelApiKey: model_api_key, data }), fullLayer);
      },
    }),

    update_record: tool({
      description: "Update fields on a record. Only include fields you want to change.",
      inputSchema: z.object({
        record_id: z.string().describe("The record ID"),
        model_api_key: z.string().describe("The model's api_key"),
        data: z.record(z.string(), z.unknown()).describe("Field values to update"),
      }),
      execute: async ({ record_id, model_api_key, data }: { record_id: string; model_api_key: string; data: Record<string, unknown> }) => {
        console.info("[chat] tool:update_record", { record_id, model_api_key, data: JSON.stringify(data).slice(0, 500) });
        const result = await run(RecordService.patchRecord(record_id, { modelApiKey: model_api_key, data }), fullLayer);
        console.info("[chat] tool:update_record result", result ? "success" : "null");
        return result;
      },
    }),

    publish_record: tool({
      description: "Publish a record.",
      inputSchema: z.object({
        model_api_key: z.string().describe("The model's api_key"),
        record_id: z.string().describe("The record ID"),
      }),
      execute: async ({ model_api_key, record_id }: { model_api_key: string; record_id: string }) => {
        console.info("[chat] tool:publish_record", { model_api_key, record_id });
        return run(PublishService.publishRecord(model_api_key, record_id), fullLayer);
      },
    }),

    list_assets: tool({
      description: "Search or list assets in the CMS asset library.",
      inputSchema: z.object({
        query: z.string().optional().describe("Search term"),
      }),
      execute: async ({ query }: { query?: string }) => {
        console.info("[chat] tool:list_assets", { query });
        return run(AssetService.searchAssets({ query, limit: 24, offset: 0 }), fullLayer);
      },
    }),

    search_content: tool({
      description: "Search CMS content across all models. Returns record IDs, model keys, and snippets. Use this to find records for internal linking.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        model_api_key: z.string().optional().describe("Restrict to a specific model"),
      }),
      execute: async ({ query, model_api_key }: { query: string; model_api_key?: string }) => {
        console.info("[chat] tool:search_content", { query, model_api_key });
        const results = await run(SearchService.search({ query, modelApiKey: model_api_key, first: 10 }), fullLayer);
        // Enrich with record titles for the model to use
        const enriched = await Promise.all(
          results.results.map(async (r) => {
            try {
              const record = await run(RecordService.getRecord(r.modelApiKey, r.recordId), fullLayer);
              const displayTitle = getDisplayTitle(record, r.recordId);
              return { ...r, title: displayTitle };
            } catch {
              return { ...r, title: r.recordId };
            }
          })
        );
        return { ...results, results: enriched };
      },
    }),

    find_linkable_content: tool({
      description: `Search for CMS records that could be linked from the current content. Returns record IDs, titles, and the markdown link syntax to use.

After calling this, use the returned [text](itemLink:RECORD_ID) syntax in your next update_structured_text call.`,
      inputSchema: z.object({
        queries: z.array(z.string()).describe("Search queries to find related content"),
      }),
      execute: async ({ queries }: { queries: string[] }) => {
        console.info("[chat] tool:find_linkable_content", { queries });
        const seen = new Set<string>();
        const records: Array<{ recordId: string; modelApiKey: string; title: string; linkSyntax: string }> = [];
        for (const query of queries) {
          const results = await run(SearchService.search({ query, first: 5 }), fullLayer);
          for (const r of results.results) {
            if (seen.has(r.recordId) || r.recordId === currentRecordId) continue;
            seen.add(r.recordId);
            try {
              const record = await run(RecordService.getRecord(r.modelApiKey, r.recordId), fullLayer);
              const displayTitle = getDisplayTitle(record, r.recordId);
              records.push({
                recordId: r.recordId,
                modelApiKey: r.modelApiKey,
                title: displayTitle,
                linkSyntax: `[${displayTitle}](itemLink:${r.recordId})`,
              });
            } catch {
              records.push({ recordId: r.recordId, modelApiKey: r.modelApiKey, title: r.recordId, linkSyntax: `[${r.recordId}](itemLink:${r.recordId})` });
            }
          }
        }
        console.info("[chat] found linkable records:", records.map((r) => r.title));
        return { records, usage: "Use the linkSyntax values in your markdown when calling update_structured_text." };
      },
    }),

    update_structured_text: tool({
      description: `Update a structured_text field using markdown. Supports full formatting: headings, bold, italic, lists, blockquotes, code blocks, links, etc.

To reference existing blocks (e.g. image blocks), include sentinel comments in the markdown:
  <!-- cms:block:BLOCK_ID -->

Example markdown:
  # My Title

  A paragraph with **bold** and *italic* text.

  <!-- cms:block:body:en:img-block-1 -->

  Another paragraph after the image block.

To add a NEW block, first use create_block to create it, then reference its ID here.`,
      inputSchema: z.object({
        record_id: z.string().describe("The record ID"),
        model_api_key: z.string().describe("The model's api_key"),
        field_api_key: z.string().describe("The structured_text field api_key"),
        locale: z.string().describe("Locale code, e.g. 'en'"),
        markdown: z.string().describe("Markdown content. Use <!-- cms:block:ID --> to position blocks."),
      }),
      execute: async ({ record_id, model_api_key, field_api_key, locale, markdown }: {
        record_id: string; model_api_key: string; field_api_key: string; locale: string; markdown: string;
      }) => {
        console.info("[chat] tool:update_structured_text", record_id, field_api_key, locale);
        console.info("[chat] markdown input:\n" + markdown.slice(0, 800));
        const { markdownToDast } = await import("../dast/markdown.js");
        const dastDocument = markdownToDast(markdown);
        // Collect block IDs referenced in the markdown
        const blockIds: string[] = [];
        for (const child of dastDocument.document.children) {
          if (child.type === "block") blockIds.push(child.item);
        }
        // Materialize existing blocks from DB so we can preserve referenced ones
        const record = await run(RecordService.getRecord(model_api_key, record_id), fullLayer);
        const currentField = record[field_api_key] as Record<string, unknown> | undefined;
        const rawValue = currentField?.[locale];
        const storageKey = StructuredTextService.getStructuredTextStorageKey(field_api_key, locale);
        const materialized = rawValue ? await run(
          StructuredTextService.materializeStructuredTextValue({
            parentContainerModelApiKey: model_api_key,
            parentBlockId: null,
            parentFieldApiKey: field_api_key,
            rootRecordId: record_id,
            rootFieldApiKey: storageKey,
            rawValue,
          }),
          fullLayer,
        ) : null;
        // Build block lookup from materialized blocks (keyed by both scoped and unscoped)
        const blockLookup = new Map<string, unknown>();
        for (const [id, data] of Object.entries(materialized?.blocks ?? {})) {
          blockLookup.set(id, data);
          blockLookup.set(unscopeBlockId(id, field_api_key, locale), data);
        }
        // Unscope all DAST block refs and resolve block data
        const blocks: Record<string, unknown> = {};
        for (const child of dastDocument.document.children) {
          if (child.type === "block") {
            const originalId = child.item;
            const unscopedId = unscopeBlockId(originalId, field_api_key, locale);
            (child as { item: string }).item = unscopedId;
            const blockData = blockLookup.get(originalId) ?? blockLookup.get(unscopedId);
            if (blockData) blocks[unscopedId] = blockData;
          }
        }
        const stValue = { value: dastDocument, blocks };
        const data = { [field_api_key]: { [locale]: stValue } };
        const result = await run(RecordService.patchRecord(record_id, { modelApiKey: model_api_key, data }), fullLayer);
        console.info("[chat] tool:update_structured_text result", result ? "success" : "null", { blockIds });
        return result;
      },
    }),

    add_block_to_structured_text: tool({
      description: `Add a new block (e.g. image_block) to a structured_text field. Provide the full markdown content with <!-- cms:block:NEW --> where you want the new block inserted. The tool creates the block and wires everything.

For image blocks, first call list_assets to get the asset ID.`,
      inputSchema: z.object({
        record_id: z.string().describe("The record ID"),
        model_api_key: z.string().describe("The model's api_key"),
        field_api_key: z.string().describe("The structured_text field api_key"),
        locale: z.string().describe("Locale code, e.g. 'en'"),
        markdown: z.string().describe("Full markdown content. Use <!-- cms:block:NEW --> where you want the new block."),
        block_type: z.string().describe("Block model api_key, e.g. 'image_block'"),
        block_data: z.record(z.string(), z.unknown()).describe("Block field values, e.g. { image: 'ASSET_ID', caption: 'Photo' }"),
      }),
      execute: async ({ record_id, model_api_key, field_api_key, locale, markdown, block_type, block_data }: {
        record_id: string; model_api_key: string; field_api_key: string; locale: string; markdown: string; block_type: string; block_data: Record<string, unknown>;
      }) => {
        console.info("[chat] tool:add_block_to_structured_text", { record_id, field_api_key, locale, block_type });
        const { ulid: generateId } = await import("ulidx");
        const { markdownToDast } = await import("../dast/markdown.js");
        const blockId = generateId();
        // Replace the NEW placeholder with the actual block ID
        const resolvedMarkdown = markdown.replace(/<!--\s*cms:block:NEW\s*-->/g, `<!-- cms:block:${blockId} -->`);
        console.info("[chat] resolved markdown:\n" + resolvedMarkdown.slice(0, 800));
        const dastDocument = markdownToDast(resolvedMarkdown);
        // Materialize existing blocks from DB to preserve them
        const record = await run(RecordService.getRecord(model_api_key, record_id), fullLayer);
        const currentField = record[field_api_key] as Record<string, unknown> | undefined;
        const rawValue = currentField?.[locale];
        const storageKey = StructuredTextService.getStructuredTextStorageKey(field_api_key, locale);
        const materialized = rawValue ? await run(
          StructuredTextService.materializeStructuredTextValue({
            parentContainerModelApiKey: model_api_key,
            parentBlockId: null,
            parentFieldApiKey: field_api_key,
            rootRecordId: record_id,
            rootFieldApiKey: storageKey,
            rawValue,
          }),
          fullLayer,
        ) : null;
        // Build block lookup from materialized blocks (keyed by both scoped and unscoped)
        const blockLookup = new Map<string, unknown>();
        for (const [id, data] of Object.entries(materialized?.blocks ?? {})) {
          blockLookup.set(id, data);
          blockLookup.set(unscopeBlockId(id, field_api_key, locale), data);
        }
        // Build blocks map: existing (unscoped) + new. Unscope all DAST refs.
        const blocks: Record<string, unknown> = {};
        for (const child of dastDocument.document.children) {
          if (child.type === "block") {
            const unscopedId = unscopeBlockId(child.item, field_api_key, locale);
            (child as { item: string }).item = unscopedId;
            if (unscopedId === blockId) {
              blocks[blockId] = { _type: block_type, ...block_data };
            } else if (blockLookup.has(child.item) || blockLookup.has(unscopedId)) {
              blocks[unscopedId] = blockLookup.get(unscopedId) ?? blockLookup.get(child.item);
            }
          }
        }
        const stValue = { value: dastDocument, blocks };
        const data = { [field_api_key]: { [locale]: stValue } };
        const result = await run(RecordService.patchRecord(record_id, { modelApiKey: model_api_key, data }), fullLayer);
        console.info("[chat] tool:add_block result", { blockId, blockCount: Object.keys(blocks).length });
        return result;
      },
    }),

    upload_image_from_url: tool({
      description: "Fetch an image from a URL and upload it. Returns asset ID for media fields.",
      inputSchema: z.object({
        url: z.string().describe("Image URL to fetch"),
        filename: z.string().optional().describe("Override filename"),
        alt: z.string().optional().describe("Alt text"),
      }),
      execute: async ({ url, filename, alt }: { url: string; filename?: string; alt?: string }) => {
        console.info("[chat] tool:upload_image_from_url", { url, filename });
        if (!options.r2Bucket) {
          return { error: "R2 bucket not configured" };
        }
        const res = await fetch(url);
        if (!res.ok) return { error: `Failed to fetch: ${res.status}` };
        const contentType = res.headers.get("Content-Type") ?? "image/jpeg";
        const bytes = await res.arrayBuffer();
        const name = filename ?? new URL(url).pathname.split("/").pop() ?? "image.jpg";
        const id = ulid();
        const r2Key = `uploads/${id}/${name}`;
        await options.r2Bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
        await run(
          AssetService.createAsset({ id, filename: name, mimeType: contentType, size: bytes.byteLength, r2Key, alt, tags: [] }),
          fullLayer,
        );
        return { assetId: id, filename: name, url: `/assets/${id}/${encodeURIComponent(name)}` };
      },
    }),
    };
  }

  return async (request: Request): Promise<Response> => {
    const body: { messages: UIMessage[]; recordId?: string; modelApiKey?: string } = await request.json();
    const tools = createTools(body.recordId);
    const lastTextPart = body.messages.at(-1)?.parts.find((part) => part.type === "text");

    console.info("[chat] request", {
      messageCount: body.messages.length,
      recordId: body.recordId,
      modelApiKey: body.modelApiKey,
      lastMessageLength: lastTextPart?.text.length ?? 0,
    });

    // Build system prompt, optionally pre-warmed with record context
    let systemPrompt = SYSTEM_PROMPT;
    if (body.recordId && body.modelApiKey) {
      try {
        const record = await run(RecordService.getRecord(body.modelApiKey, body.recordId), fullLayer);
        const modelRow = await run(ModelService.getModelByApiKey(body.modelApiKey), fullLayer);
        const fields = await run(FieldService.listFields(modelRow.id), fullLayer);
        const locales = await run(
          SchemaIO.exportSchema().pipe(Effect.map((s) => s.locales.map((l) => l.code))),
          fullLayer,
        );

        // Record health
        const status = typeof record._status === "string" ? record._status : "unknown";
        const publishedAt = typeof record._published_at === "string" ? record._published_at : null;
        const hasDraft = status === "draft" || status === "updated";

        // Field completeness + structured text markdown preview
        const { dastToMarkdown } = await import("../dast/markdown.js");
        const fieldSummaries: unknown[] = [];
        const markdownPreviews: string[] = [];

        for (const f of fields as Array<{ api_key: string; field_type: string; localized: number; label: string; validators: Record<string, unknown> }>) {
          const val = record[f.api_key];
          const required = Boolean(f.validators.required);
          const summary: Record<string, unknown> = { api_key: f.api_key, label: f.label, type: f.field_type, localized: !!f.localized, required };

          if (f.localized) {
            const localizedVal = val as Record<string, unknown> | undefined;
            const filledLocales = localizedVal ? locales.filter((l) => {
              const v = localizedVal[l];
              return v !== null && v !== undefined && v !== "";
            }) : [];
            summary.filled = filledLocales;
            summary.missing = locales.filter((l) => !filledLocales.includes(l));

            // For structured_text, show markdown source + block info per locale
            if (f.field_type === "structured_text" && localizedVal) {
              for (const locale of filledLocales) {
                const stVal = localizedVal[locale] as { schema?: string; document?: unknown } | undefined;
                if (stVal?.document) {
                  try {
                    const md = dastToMarkdown({ schema: "dast", document: stVal.document as { type: "root"; children: [] } });
                    markdownPreviews.push(`Current ${f.api_key} [${locale}] markdown source (use this format when rewriting):\n\`\`\`markdown\n${md}\`\`\``);
                  } catch { /* skip */ }
                }
                // Materialize blocks to show what's available
                const storageKey = StructuredTextService.getStructuredTextStorageKey(f.api_key, locale);
                try {
                  const materialized = await run(
                    StructuredTextService.materializeStructuredTextValue({
                      parentContainerModelApiKey: body.modelApiKey,
                      parentBlockId: null,
                      parentFieldApiKey: f.api_key,
                      rootRecordId: body.recordId,
                      rootFieldApiKey: storageKey,
                      rawValue: localizedVal[locale],
                    }),
                    fullLayer,
                  );
                  if (materialized?.blocks && Object.keys(materialized.blocks).length > 0) {
                    markdownPreviews.push(`Blocks in ${f.api_key} [${locale}]:\n${Object.entries(materialized.blocks).map(([id, b]) => `  ${id}: ${JSON.stringify(b)}`).join("\n")}`);
                  }
                } catch { /* skip */ }
              }
            }
          } else {
            summary.filled = val !== null && val !== undefined && val !== "";
          }
          fieldSummaries.push(summary);
        }

        systemPrompt += `

ACTIVE RECORD — use these exact values with update_record:
  record_id: "${body.recordId}"
  model_api_key: "${body.modelApiKey}"
  status: ${status}${hasDraft ? " (unpublished changes)" : ""}
  published: ${publishedAt ?? "never"}
  locales: [${locales.join(", ")}]

Fields: ${JSON.stringify(fieldSummaries)}

${markdownPreviews.length > 0 ? markdownPreviews.join("\n\n") + "\n\n" : ""}Current values: ${JSON.stringify(record)}`;

        console.info("[chat] pre-warmed with record", { recordId: body.recordId, status, fieldCount: fields.length, systemPromptLength: systemPrompt.length });
      } catch (err) {
        console.error("[chat] pre-warm failed", err);
      }
    }

    const modelMessages = await convertToModelMessages(body.messages);
    console.info("[chat] sending to model", { modelMessageCount: modelMessages.length, systemPromptLength: systemPrompt.length });

    const result = streamText({
      model,
      tools,
      messages: modelMessages,
      system: systemPrompt,
      maxOutputTokens: 2048,
      stopWhen: stepCountIs(5),
      onStepFinish: (step) => {
        console.info("[chat] step finished", {
          text: step.text.slice(0, 200),
          toolCalls: step.toolCalls.map((tc) => ({ name: tc.toolName, input: JSON.stringify(tc.input).slice(0, 200) })),
          toolResults: step.toolResults.map((tr) => ({ name: tr.toolName, output: JSON.stringify(tr.output).slice(0, 200) })),
          finishReason: step.finishReason,
        });
      },
    });

    return result.toUIMessageStreamResponse();
  };
}
