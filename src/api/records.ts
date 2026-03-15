import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Env } from "../types.js";
import type { FieldType } from "../types.js";
import * as schema from "../db/schema.js";
import { generateSchema } from "../schema-engine/index.js";

export const recordsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

/** Build the generated schema from current system tables */
function getGeneratedSchema(db: any) {
  const allModels = db.select().from(schema.models).all();
  const allFields = db.select().from(schema.fields).all();
  return generateSchema(allModels as any, allFields as any);
}

/** Validate record data against field definitions */
function validateRecordData(
  data: Record<string, any>,
  fields: { apiKey: string; fieldType: string; validators: Record<string, unknown> }[]
): string | null {
  for (const field of fields) {
    const value = data[field.apiKey];
    const validators = field.validators ?? {};

    if (validators.required && (value === undefined || value === null || value === "")) {
      return `Field '${field.apiKey}' is required`;
    }
  }
  return null;
}

// POST /api/records — create a record
recordsApi.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  if (!body.modelApiKey || typeof body.modelApiKey !== "string") {
    return c.json({ error: "modelApiKey is required" }, 400);
  }

  const model = db
    .select()
    .from(schema.models)
    .where(eq(schema.models.apiKey, body.modelApiKey))
    .get() as any;
  if (!model) {
    return c.json({ error: `Model '${body.modelApiKey}' not found` }, 404);
  }
  if (model.isBlock) {
    return c.json({ error: "Cannot create records for block types directly" }, 400);
  }

  // Singleton check
  if (model.singleton) {
    const generated = getGeneratedSchema(db);
    const table = generated.tables.get(model.apiKey)!;
    const existing = db.select().from(table).all();
    if (existing.length > 0) {
      return c.json({ error: `Model '${model.apiKey}' is a singleton and already has a record` }, 409);
    }
  }

  const modelFields = db
    .select()
    .from(schema.fields)
    .where(eq(schema.fields.modelId, model.id))
    .all() as any[];

  // Validate
  const validationError = validateRecordData(body.data ?? {}, modelFields);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const generated = getGeneratedSchema(db);
  const table = generated.tables.get(model.apiKey);
  if (!table) {
    return c.json({ error: "Content table not found" }, 500);
  }

  const now = new Date().toISOString();
  const id = ulid();

  const record: Record<string, any> = {
    id,
    _status: "draft",
    _createdAt: now,
    _updatedAt: now,
  };

  // Copy field values from body.data
  const data = body.data ?? {};
  for (const field of modelFields) {
    if (data[field.apiKey] !== undefined) {
      record[field.apiKey] = data[field.apiKey];
    }
  }

  db.insert(table).values(record).run();

  return c.json({ id, ...record }, 201);
});

// GET /api/records?modelApiKey=... — list records
recordsApi.get("/", (c) => {
  const db = c.get("db");
  const modelApiKey = c.req.query("modelApiKey");

  if (!modelApiKey) {
    return c.json({ error: "modelApiKey query parameter is required" }, 400);
  }

  const model = db
    .select()
    .from(schema.models)
    .where(eq(schema.models.apiKey, modelApiKey))
    .get();
  if (!model) {
    return c.json({ error: `Model '${modelApiKey}' not found` }, 404);
  }

  const generated = getGeneratedSchema(db);
  const table = generated.tables.get(modelApiKey);
  if (!table) {
    return c.json({ error: "Content table not found" }, 500);
  }

  const records = db.select().from(table).all();
  return c.json(records);
});

// GET /api/records/:id?modelApiKey=... — get a single record
recordsApi.get("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const modelApiKey = c.req.query("modelApiKey");

  if (!modelApiKey) {
    return c.json({ error: "modelApiKey query parameter is required" }, 400);
  }

  const generated = getGeneratedSchema(db);
  const table = generated.tables.get(modelApiKey);
  if (!table) {
    return c.json({ error: `Model '${modelApiKey}' not found` }, 404);
  }

  const record = db.select().from(table).where(eq(table.id, id)).get();
  if (!record) {
    return c.json({ error: "Record not found" }, 404);
  }

  return c.json(record);
});

// PATCH /api/records/:id — update a record
recordsApi.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json();

  if (!body.modelApiKey) {
    return c.json({ error: "modelApiKey is required" }, 400);
  }

  const model = db
    .select()
    .from(schema.models)
    .where(eq(schema.models.apiKey, body.modelApiKey))
    .get() as any;
  if (!model) {
    return c.json({ error: `Model '${body.modelApiKey}' not found` }, 404);
  }

  const generated = getGeneratedSchema(db);
  const table = generated.tables.get(body.modelApiKey);
  if (!table) {
    return c.json({ error: "Content table not found" }, 500);
  }

  const existing = db.select().from(table).where(eq(table.id, id)).get() as any;
  if (!existing) {
    return c.json({ error: "Record not found" }, 404);
  }

  const modelFields = db
    .select()
    .from(schema.fields)
    .where(eq(schema.fields.modelId, model.id))
    .all() as any[];

  const updates: Record<string, any> = {
    _updatedAt: new Date().toISOString(),
  };

  // If record was published, mark as updated (has unpublished changes)
  if (existing._status === "published") {
    updates._status = "updated";
  }

  const data = body.data ?? {};
  for (const field of modelFields) {
    if (data[field.apiKey] !== undefined) {
      updates[field.apiKey] = data[field.apiKey];
    }
  }

  db.update(table).set(updates).where(eq(table.id, id)).run();

  const updated = db.select().from(table).where(eq(table.id, id)).get();
  return c.json(updated);
});

// DELETE /api/records/:id?modelApiKey=... — delete a record
recordsApi.delete("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const modelApiKey = c.req.query("modelApiKey");

  if (!modelApiKey) {
    return c.json({ error: "modelApiKey query parameter is required" }, 400);
  }

  const generated = getGeneratedSchema(db);
  const table = generated.tables.get(modelApiKey);
  if (!table) {
    return c.json({ error: `Model '${modelApiKey}' not found` }, 404);
  }

  const existing = db.select().from(table).where(eq(table.id, id)).get();
  if (!existing) {
    return c.json({ error: "Record not found" }, 404);
  }

  db.delete(table).where(eq(table.id, id)).run();

  return c.json({ deleted: true });
});
