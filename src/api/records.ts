import { Hono } from "hono";
import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Env } from "../types.js";
import * as schema from "../db/schema.js";
import { generateSchema } from "../schema-engine/index.js";
import { generateSlug } from "../slug.js";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import { runEffect } from "../effect-helpers.js";

export const recordsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

function getGeneratedSchema(db: any) {
  const allModels = db.select().from(schema.models).all();
  const allFields = db.select().from(schema.fields).all();
  return generateSchema(allModels as any, allFields as any);
}

// POST /api/records
recordsApi.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  return runEffect(
    c,
    Effect.gen(function* () {
      if (!body.modelApiKey || typeof body.modelApiKey !== "string")
        return yield* new ValidationError({ message: "modelApiKey is required" });

      const model = db.select().from(schema.models)
        .where(eq(schema.models.apiKey, body.modelApiKey)).get() as any;
      if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });
      if (model.isBlock)
        return yield* new ValidationError({ message: "Cannot create records for block types directly" });

      const generated = getGeneratedSchema(db);
      const table = generated.tables.get(model.apiKey)!;

      // Singleton check
      if (model.singleton) {
        const existing = db.select().from(table).all();
        if (existing.length > 0)
          return yield* new DuplicateError({ message: `Model '${model.apiKey}' is a singleton and already has a record` });
      }

      const modelFields = db.select().from(schema.fields)
        .where(eq(schema.fields.modelId, model.id)).all() as any[];

      // Validate required fields
      const data = body.data ?? {};
      for (const field of modelFields) {
        const validators = (field.validators ?? {}) as Record<string, any>;
        if (validators.required && (data[field.apiKey] === undefined || data[field.apiKey] === null || data[field.apiKey] === ""))
          return yield* new ValidationError({ message: `Field '${field.apiKey}' is required`, field: field.apiKey });
      }

      const now = new Date().toISOString();
      const id = ulid();
      const record: Record<string, any> = { id, _status: "draft", _createdAt: now, _updatedAt: now };

      // Process fields — slug auto-generation, etc.
      for (const field of modelFields) {
        if (field.fieldType === "slug") {
          const sourceFieldKey = (field.validators as any)?.slug_source;
          if (!data[field.apiKey] && sourceFieldKey && data[sourceFieldKey]) {
            data[field.apiKey] = generateSlug(data[sourceFieldKey]);
          } else if (data[field.apiKey]) {
            data[field.apiKey] = generateSlug(data[field.apiKey]);
          }
          // Enforce uniqueness
          if (data[field.apiKey]) {
            let slug = data[field.apiKey];
            let suffix = 1;
            while (db.select().from(table).where(eq((table as any)[field.apiKey], slug)).get()) {
              suffix++;
              slug = `${data[field.apiKey]}-${suffix}`;
            }
            data[field.apiKey] = slug;
          }
        }
        if (data[field.apiKey] !== undefined) record[field.apiKey] = data[field.apiKey];
      }

      db.insert(table).values(record).run();
      return { id, ...record };
    }),
    201
  );
});

// GET /api/records?modelApiKey=...
recordsApi.get("/", (c) => {
  const db = c.get("db");
  const modelApiKey = c.req.query("modelApiKey");

  return runEffect(
    c,
    Effect.gen(function* () {
      if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
      const generated = getGeneratedSchema(db);
      const table = generated.tables.get(modelApiKey);
      if (!table) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
      return db.select().from(table).all();
    })
  );
});

// GET /api/records/:id?modelApiKey=...
recordsApi.get("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id")!;
  const modelApiKey = c.req.query("modelApiKey");

  return runEffect(
    c,
    Effect.gen(function* () {
      if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
      const generated = getGeneratedSchema(db);
      const table = generated.tables.get(modelApiKey);
      if (!table) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
      const record = db.select().from(table).where(eq(table.id, id)).get();
      if (!record) return yield* new NotFoundError({ entity: "Record", id });
      return record;
    })
  );
});

// PATCH /api/records/:id
recordsApi.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id")!;
  const body = await c.req.json();

  return runEffect(
    c,
    Effect.gen(function* () {
      if (!body.modelApiKey) return yield* new ValidationError({ message: "modelApiKey is required" });
      const model = db.select().from(schema.models)
        .where(eq(schema.models.apiKey, body.modelApiKey)).get() as any;
      if (!model) return yield* new NotFoundError({ entity: "Model", id: body.modelApiKey });

      const generated = getGeneratedSchema(db);
      const table = generated.tables.get(body.modelApiKey)!;
      const existing = db.select().from(table).where(eq(table.id, id)).get() as any;
      if (!existing) return yield* new NotFoundError({ entity: "Record", id });

      const modelFields = db.select().from(schema.fields)
        .where(eq(schema.fields.modelId, model.id)).all() as any[];

      const updates: Record<string, any> = { _updatedAt: new Date().toISOString() };
      if (existing._status === "published") updates._status = "updated";

      const data = body.data ?? {};
      for (const field of modelFields) {
        if (data[field.apiKey] !== undefined) updates[field.apiKey] = data[field.apiKey];
      }

      db.update(table).set(updates).where(eq(table.id, id)).run();
      return db.select().from(table).where(eq(table.id, id)).get();
    })
  );
});

// DELETE /api/records/:id?modelApiKey=...
recordsApi.delete("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id")!;
  const modelApiKey = c.req.query("modelApiKey");

  return runEffect(
    c,
    Effect.gen(function* () {
      if (!modelApiKey) return yield* new ValidationError({ message: "modelApiKey query parameter is required" });
      const generated = getGeneratedSchema(db);
      const table = generated.tables.get(modelApiKey);
      if (!table) return yield* new NotFoundError({ entity: "Model", id: modelApiKey });
      const existing = db.select().from(table).where(eq(table.id, id)).get();
      if (!existing) return yield* new NotFoundError({ entity: "Record", id });
      db.delete(table).where(eq(table.id, id)).run();
      return { deleted: true };
    })
  );
});
