import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Env } from "../types.js";
import { FIELD_TYPES, type FieldType } from "../types.js";
import * as schema from "../db/schema.js";
import { generateSchema, migrateTable } from "../schema-engine/index.js";

export const fieldsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

/** Re-generate and migrate the dynamic table for a model */
function syncModelTable(db: any, modelId: string) {
  const allModels = db.select().from(schema.models).all();
  const allFields = db.select().from(schema.fields).all();
  const generated = generateSchema(allModels as any, allFields as any);

  const model = allModels.find((m: any) => m.id === modelId) as any;
  if (!model) return;

  const table = generated.tables.get(model.apiKey);
  if (table) {
    migrateTable(db, table);
  }
}

// GET /api/models/:modelId/fields — list fields for a model
fieldsApi.get("/", (c) => {
  const db = c.get("db");
  const modelId = c.req.param("modelId")!;

  const model = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
  if (!model) {
    return c.json({ error: "Model not found" }, 404);
  }

  const fields = db
    .select()
    .from(schema.fields)
    .where(eq(schema.fields.modelId, modelId))
    .all();

  return c.json(fields);
});

// POST /api/models/:modelId/fields — create a field
fieldsApi.post("/", async (c) => {
  const db = c.get("db");
  const modelId = c.req.param("modelId")!;
  const body = await c.req.json();

  // Validate model exists
  const model = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
  if (!model) {
    return c.json({ error: "Model not found" }, 404);
  }

  // Validate required fields
  if (!body.label || typeof body.label !== "string") {
    return c.json({ error: "label is required and must be a string" }, 400);
  }
  if (!body.apiKey || typeof body.apiKey !== "string") {
    return c.json({ error: "apiKey is required and must be a string" }, 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey)) {
    return c.json({ error: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" }, 400);
  }
  if (!body.fieldType || !FIELD_TYPES.includes(body.fieldType as FieldType)) {
    return c.json({ error: `fieldType must be one of: ${FIELD_TYPES.join(", ")}` }, 400);
  }

  // Check uniqueness within the model
  const existingField = db
    .select()
    .from(schema.fields)
    .where(and(eq(schema.fields.modelId, modelId), eq(schema.fields.apiKey, body.apiKey)))
    .get();
  if (existingField) {
    return c.json({ error: `Field with apiKey '${body.apiKey}' already exists on this model` }, 409);
  }

  // Determine position
  const existingFields = db
    .select()
    .from(schema.fields)
    .where(eq(schema.fields.modelId, modelId))
    .all();
  const position = body.position ?? existingFields.length;

  const now = new Date().toISOString();
  const id = ulid();

  const field = {
    id,
    modelId,
    label: body.label,
    apiKey: body.apiKey,
    fieldType: body.fieldType,
    position,
    localized: body.localized ?? false,
    validators: body.validators ?? {},
    defaultValue: body.defaultValue ?? null,
    appearance: body.appearance ?? null,
    hint: body.hint ?? null,
    fieldsetId: body.fieldsetId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.fields).values(field).run();

  // Sync the dynamic table (adds the column)
  syncModelTable(db, modelId);

  return c.json(field, 201);
});

// PATCH /api/fields/:id — update a field
fieldsApi.patch("/:fieldId", async (c) => {
  const db = c.get("db");
  const fieldId = c.req.param("fieldId")!;
  const body = await c.req.json();

  const existing = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get() as any;
  if (!existing) {
    return c.json({ error: "Field not found" }, 404);
  }

  const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (body.label !== undefined) updates.label = body.label;
  if (body.position !== undefined) updates.position = body.position;
  if (body.localized !== undefined) updates.localized = body.localized;
  if (body.validators !== undefined) updates.validators = body.validators;
  if (body.hint !== undefined) updates.hint = body.hint;
  if (body.appearance !== undefined) updates.appearance = body.appearance;

  db.update(schema.fields).set(updates).where(eq(schema.fields.id, fieldId)).run();

  const updated = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get();
  return c.json(updated);
});

// DELETE /api/fields/:id — delete a field
fieldsApi.delete("/:fieldId", (c) => {
  const db = c.get("db");
  const fieldId = c.req.param("fieldId")!;

  const field = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get() as any;
  if (!field) {
    return c.json({ error: "Field not found" }, 404);
  }

  const modelId = field.modelId;

  // Delete the field
  db.delete(schema.fields).where(eq(schema.fields.id, fieldId)).run();

  // Sync the dynamic table (drops the column)
  syncModelTable(db, modelId);

  return c.json({ deleted: true });
});
