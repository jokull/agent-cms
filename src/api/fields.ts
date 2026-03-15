import { Hono } from "hono";
import type { Env } from "../types.js";
import { runEffect } from "../effect-helpers.js";
import * as FieldService from "../services/field-service.js";

export const fieldsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

fieldsApi.get("/", (c) => runEffect(c, FieldService.listFields(c.req.param("modelId")!)));

fieldsApi.post("/", async (c) =>
  runEffect(c, FieldService.createField(c.req.param("modelId")!, await c.req.json()), 201)
);

fieldsApi.patch("/:fieldId", async (c) =>
  runEffect(c, FieldService.updateField(c.req.param("fieldId")!, await c.req.json()))
);

fieldsApi.delete("/:fieldId", (c) =>
  runEffect(c, FieldService.deleteField(c.req.param("fieldId")!))
);
