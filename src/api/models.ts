import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ulid } from "ulidx";
import type { Env } from "../types.js";
import * as schema from "../db/schema.js";
import { generateSchema, migrateTable, dropTable } from "../schema-engine/index.js";

export const modelsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

// GET /models — list all models
modelsApi.get("/", (c) => {
  const db = c.get("db");
  const models = db.select().from(schema.models).all();
  return c.json(models);
});

// GET /models/:id — get a single model with its fields
modelsApi.get("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const model = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
  if (!model) {
    return c.json({ error: "Model not found" }, 404);
  }

  const fields = db
    .select()
    .from(schema.fields)
    .where(eq(schema.fields.modelId, id))
    .all();

  return c.json({ ...model, fields });
});

// POST /models — create a new model and its dynamic table
modelsApi.post("/", async (c) => {
  const db = c.get("db");
  const body = await c.req.json();

  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required and must be a string" }, 400);
  }
  if (!body.apiKey || typeof body.apiKey !== "string") {
    return c.json({ error: "apiKey is required and must be a string" }, 400);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(body.apiKey)) {
    return c.json(
      { error: "apiKey must start with a lowercase letter and contain only lowercase letters, numbers, and underscores" },
      400
    );
  }

  const existing = db
    .select()
    .from(schema.models)
    .where(eq(schema.models.apiKey, body.apiKey))
    .get();
  if (existing) {
    return c.json({ error: `Model with apiKey '${body.apiKey}' already exists` }, 409);
  }

  const now = new Date().toISOString();
  const id = ulid();

  const model = {
    id,
    name: body.name,
    apiKey: body.apiKey,
    isBlock: body.isBlock ?? false,
    singleton: body.singleton ?? false,
    sortable: body.sortable ?? false,
    tree: body.tree ?? false,
    hasDraft: body.hasDraft ?? true,
    ordering: body.ordering ?? null,
    createdAt: now,
    updatedAt: now,
  };

  db.insert(schema.models).values(model).run();

  // Generate and migrate the dynamic table
  const allModels = db.select().from(schema.models).all();
  const allFields = db.select().from(schema.fields).all();
  const generated = generateSchema(allModels as any, allFields as any);
  const table = generated.tables.get(body.apiKey);
  if (table) {
    migrateTable(db, table);
  }

  return c.json(model, 201);
});

// PATCH /models/:id — update a model
modelsApi.patch("/:id", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");
  const body = await c.req.json();

  const existing = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
  if (!existing) {
    return c.json({ error: "Model not found" }, 404);
  }

  const updates: Record<string, any> = { updatedAt: new Date().toISOString() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.singleton !== undefined) updates.singleton = body.singleton;
  if (body.sortable !== undefined) updates.sortable = body.sortable;
  if (body.hasDraft !== undefined) updates.hasDraft = body.hasDraft;

  db.update(schema.models).set(updates).where(eq(schema.models.id, id)).run();

  const updated = db.select().from(schema.models).where(eq(schema.models.id, id)).get();
  return c.json(updated);
});

// DELETE /models/:id — delete a model (strict reference checking)
modelsApi.delete("/:id", (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const model = db.select().from(schema.models).where(eq(schema.models.id, id)).get() as any;
  if (!model) {
    return c.json({ error: "Model not found" }, 404);
  }

  // Strict reference checking: refuse if other models reference this one
  if (!model.isBlock) {
    const allFields = db.select().from(schema.fields).all() as any[];
    const referencingFields = allFields.filter((f: any) => {
      if (f.fieldType !== "link" && f.fieldType !== "links") return false;
      if (f.modelId === id) return false;
      const validators = (f.validators ?? {}) as Record<string, any>;
      const allowedTypes = validators?.items_item_type ?? validators?.item_item_type;
      if (Array.isArray(allowedTypes)) {
        return allowedTypes.includes(model.apiKey);
      }
      return false;
    });

    if (referencingFields.length > 0) {
      const refs = referencingFields.map((f: any) => {
        const refModel = db
          .select()
          .from(schema.models)
          .where(eq(schema.models.id, f.modelId))
          .get() as any;
        return `${refModel?.apiKey ?? "unknown"}.${f.apiKey}`;
      });
      return c.json(
        { error: `Cannot delete model '${model.apiKey}': referenced by fields: ${refs.join(", ")}` },
        409
      );
    }
  }

  // Drop the dynamic table
  const tableName = model.isBlock ? `block_${model.apiKey}` : `content_${model.apiKey}`;
  dropTable(db, tableName);

  // Delete model (cascade will delete fields via FK)
  db.delete(schema.models).where(eq(schema.models.id, id)).run();

  return c.json({ deleted: true });
});
