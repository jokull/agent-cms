import { createCMSHandler, type CmsEnv } from "agent-cms";

export default {
  fetch(request: Request, env: CmsEnv): Promise<Response> {
    return createCMSHandler(env).fetch(request);
  },
};
