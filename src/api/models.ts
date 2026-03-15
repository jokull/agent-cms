import { Hono } from "hono";
import type { Env } from "../types.js";
import { runEffect } from "../effect-helpers.js";
import * as ModelService from "../services/model-service.js";

export const modelsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

modelsApi.get("/", (c) => runEffect(c, ModelService.listModels()));

modelsApi.get("/:id", (c) => runEffect(c, ModelService.getModel(c.req.param("id")!)));

modelsApi.post("/", async (c) => runEffect(c, ModelService.createModel(await c.req.json()), 201));

modelsApi.patch("/:id", async (c) =>
  runEffect(c, ModelService.updateModel(c.req.param("id")!, await c.req.json()))
);

modelsApi.delete("/:id", (c) => runEffect(c, ModelService.deleteModel(c.req.param("id")!)));
