import handler from "vinext/server/app-router-entry";

interface Env {
  [key: string]: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") {
        process.env[key] = value;
      }
    }
    return handler.fetch(request);
  },
};
