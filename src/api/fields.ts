import { Hono } from "hono";
import { Effect } from "effect";
import { eq, and } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Env } from "../types.js";
import { FIELD_TYPES, type FieldType } from "../types.js";
import * as schema from "../db/schema.js";
import { generateSchema, migrateTable } from "../schema-engine/index.js";
import { NotFoundError, ValidationError, DuplicateError } from "../errors.js";
import { runEffect } from "../effect-helpers.js";

export const fieldsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

function syncModelTable(db: any, modelId: string) {
  const allModels = db.select().from(schema.models).all();
  const allFields = db.select().from(schema.fields).all();
  const generated = generateSchema(allModels as any, allFields as any);
  const model = allModels.find((m: any) => m.id === modelId) as any;
  if (!model) return;
  const table = generated.tables.get(model.apiKey);
  if (table) migrateTable(db, table);
}

// GET /api/models/:modelId/fields
fieldsApi.get("/", (c) => {
  const db = c.get("db");
  const modelId = c.req.param("modelId")!;

  return runEffect(
    c,
    Effect.gen(function* () {
      const model = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
      if (!model) return yield* new NotFoundError({ entity: "Model", id: modelId });
      return db.select().from(schema.fields).where(eq(schema.fields.modelId, modelId)).all();
    })
  );
});

// POST /api/models/:modelId/fields
fieldsApi.post("/", async (c) => {
  const db = c.get("db");
  const modelId = c.req.param("modelId")!;
  const body = await c.req.json();

  return runEffect(
    c,
    Effect.gen(function* () {
      const model = db.select().from(schema.models).where(eq(schema.models.id, modelId)).get();
      if (!model) return yield* new NotFoundError({ entity: "Model", id: modelId });

      if (!body.label || typeof body.label !== "string")
        return yield* new ValidationError({ message: "label is required and must be a string" });
      if (!body.apiKey || typeof body.apiKey !== "string")
        return yield* new ValidationError({ message: "apiKey is required and must be a string" });
      if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey))
        return yield* new ValidationError({ message: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" });
      if (!body.fieldType || !FIELD_TYPES.includes(body.fieldType as FieldType))
        return yield* new ValidationError({ message: `fieldType must be one of: ${FIELD_TYPES.join(", ")}` });

      const existingField = db.select().from(schema.fields)
        .where(and(eq(schema.fields.modelId, modelId), eq(schema.fields.apiKey, body.apiKey)))
        .get();
      if (existingField)
        return yield* new DuplicateError({ message: `Field with apiKey '${body.apiKey}' already exists on this model` });

      const existingFields = db.select().from(schema.fields).where(eq(schema.fields.modelId, modelId)).all();
      const position = body.position ?? existingFields.length;
      const now = new Date().toISOString();
      const id = ulid();

      const field = {
        id, modelId, label: body.label, apiKey: body.apiKey, fieldType: body.fieldType,
        position, localized: body.localized ?? false, validators: body.validators ?? {},
        defaultValue: body.defaultValue ?? null, appearance: body.appearance ?? null,
        hint: body.hint ?? null, fieldsetId: body.fieldsetId ?? null,
        createdAt: now, updatedAt: now,
      };

      db.insert(schema.fields).values(field).run();
      syncModelTable(db, modelId);
      return field;
    }),
    201
  );
});

// PATCH /api/models/:modelId/fields/:fieldId
fieldsApi.patch("/:fieldId", async (c) => {
  const db = c.get("db");
  const fieldId = c.req.param("fieldId")!;
  const body = await c.req.json();

  return runEffect(
    c,
    Effect.gen(function* () {
      const existing = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get();
      if (!existing) return yield* new NotFoundError({ entity: "Field", id: fieldId });

      const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
      if (body.label !== undefined) updates.label = body.label;
      if (body.position !== undefined) updates.position = body.position;
      if (body.localized !== undefined) updates.localized = body.localized;
      if (body.validators !== undefined) updates.validators = body.validators;
      if (body.hint !== undefined) updates.hint = body.hint;
      if (body.appearance !== undefined) updates.appearance = body.appearance;

      db.update(schema.fields).set(updates).where(eq(schema.fields.id, fieldId)).run();
      return db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get();
    })
  );
});

// DELETE /api/models/:modelId/fields/:fieldId
fieldsApi.delete("/:fieldId", (c) => {
  const db = c.get("db");
  const fieldId = c.req.param("fieldId")!;

  return runEffect(
    c,
    Effect.gen(function* () {
      const field = db.select().from(schema.fields).where(eq(schema.fields.id, fieldId)).get() as any;
      if (!field) return yield* new NotFoundError({ entity: "Field", id: fieldId });

      db.delete(schema.fields).where(eq(schema.fields.id, fieldId)).run();
      syncModelTable(db, field.modelId);
      return { deleted: true };
    })
  );
});
