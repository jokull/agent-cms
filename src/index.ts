import { D1Client } from "@effect/sql-d1";
import type { Env } from "./types.js";
import { createWebHandler } from "./http/router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const sqlLayer = D1Client.layer({ db: env.DB });
    const handler = createWebHandler(sqlLayer);
    return handler(request);
  },
};
