/**
 * Optional extra seed: the blog example seeds no assets, so the Media page
 * would be empty. This creates two metadata-only asset rows (no R2 needed) and
 * attaches one to a post's cover_image so `assets.usages` and the
 * reference-conflict guard on `assets.delete` have something to show.
 *
 *   pnpm exec tsx seed-assets.mts
 */
import { batchFetchTransport, createBrowserClient } from "result-rpc/client";
import { contract } from "./src/contract.js";

const url = process.env.ADMIN_RPC_URL ?? "http://127.0.0.1:8788/rpc";
const client = createBrowserClient({
  contract,
  transport: batchFetchTransport({
    url,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      request.headers.set("x-admin-user", "ada");
      return fetch(request);
    },
  }),
});

const wanted = [
  { filename: "kyoto-autumn.jpg", mimeType: "image/jpeg", size: 482_113, width: 1600, height: 1067, alt: "Maple leaves" },
  { filename: "tokyo-night.jpg", mimeType: "image/jpeg", size: 391_204, width: 1600, height: 900, alt: "Neon street" },
];

const ids: string[] = [];
for (const data of wanted) {
  const created = await client.cms.assets.create({ data });
  if (created.ok) {
    ids.push(created.value.id);
    console.log("asset", created.value.id, created.value.filename);
  } else {
    console.log("asset failed", JSON.stringify(created.error));
  }
}

const posts = await client.cms.post.list({ page: { limit: 1 } });
const first = posts.ok ? posts.value.records[0] : undefined;
if (first && ids[0]) {
  const attached = await client.cms.post.update({ id: first.id, data: { cover_image: ids[0] } });
  console.log("attached cover to", first.id, attached.ok);
}
