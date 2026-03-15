import { Hono } from "hono";
import type { Env } from "../types.js";
import { runEffect } from "../effect-helpers.js";
import * as RecordService from "../services/record-service.js";

export const recordsApi = new Hono<{ Bindings: Env; Variables: { db: any } }>();

recordsApi.post("/", async (c) =>
  runEffect(c, RecordService.createRecord(await c.req.json()), 201)
);

recordsApi.get("/", (c) =>
  runEffect(c, RecordService.listRecords(c.req.query("modelApiKey") ?? ""))
);

recordsApi.get("/:id", (c) =>
  runEffect(c, RecordService.getRecord(c.req.query("modelApiKey") ?? "", c.req.param("id")!))
);

recordsApi.patch("/:id", async (c) =>
  runEffect(c, RecordService.patchRecord(c.req.param("id")!, await c.req.json()))
);

recordsApi.delete("/:id", (c) =>
  runEffect(c, RecordService.removeRecord(c.req.query("modelApiKey") ?? "", c.req.param("id")!))
);
