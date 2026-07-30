/**
 * Seeds REAL image assets so the admin's media grid, list thumbnails and block
 * cards have something to render (FRICTION.md #3 — the app used to draw an
 * asset id in a dashed box because no URL existed anywhere on the surface).
 *
 * The images are generated locally (a tiny hand-rolled PNG encoder, no network,
 * no dependencies) and uploaded through the blog example's CMS Worker, which
 * owns the R2 binding:
 *
 *   1. `PUT /api/assets/:id/file`  — bytes into R2 at `uploads/<id>/<filename>`
 *   2. `POST /api/assets`          — the metadata row
 *   3. `PATCH /api/records/:id`    — attach to a post's cover_image + gallery
 *
 * Run the blog CMS first (it and the admin worker share one local wrangler
 * state directory, so the admin sees both the D1 rows and the R2 objects):
 *
 *   cd examples/blog/cms && pnpm exec wrangler dev --port 8787 --local
 *   cd examples/admin    && node --experimental-strip-types seed-assets.mts
 */
import { deflateSync } from "node:zlib";

const CMS = process.env.ADMIN_CMS_URL ?? "http://127.0.0.1:8787";

// --- minimal PNG encoder (RGB, no filtering) ---------------------------------

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const out = new Uint8Array(body.length + 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(out.length - 4, crc32(body));
  return out;
}

/** A width×height gradient PNG — deterministic, a few kB, and clearly an image. */
function makePng(width: number, height: number, hue: readonly [number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const t = x / width;
      const v = y / height;
      const i = rowStart + 1 + x * 3;
      raw[i] = Math.round(hue[0] * (0.35 + 0.65 * t));
      raw[i + 1] = Math.round(hue[1] * (0.35 + 0.65 * (1 - v)));
      raw[i + 2] = Math.round(hue[2] * (0.35 + 0.65 * ((t + v) / 2)));
    }
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

// --- seeding ------------------------------------------------------------------

async function json(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const WANTED = [
  { filename: "kyoto-autumn.png", alt: "Maple gradient", hue: [220, 90, 60] as const, width: 960, height: 640 },
  { filename: "tokyo-night.png", alt: "Neon gradient", hue: [90, 120, 240] as const, width: 960, height: 540 },
  { filename: "shinkansen.png", alt: "Speed gradient", hue: [60, 200, 170] as const, width: 800, height: 800 },
];

const created: string[] = [];

for (const wanted of WANTED) {
  const id = crypto.randomUUID();
  const bytes = makePng(wanted.width, wanted.height, wanted.hue);

  const uploaded = await fetch(`${CMS}/api/assets/${id}/file`, {
    method: "PUT",
    headers: { "Content-Type": "image/png", "X-Filename": wanted.filename },
    body: bytes,
  });
  if (!uploaded.ok) {
    console.error("upload failed", wanted.filename, await json(uploaded));
    continue;
  }

  const registered = await fetch(`${CMS}/api/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      filename: wanted.filename,
      mimeType: "image/png",
      size: bytes.byteLength,
      width: wanted.width,
      height: wanted.height,
      alt: wanted.alt,
      r2Key: `uploads/${id}/${wanted.filename}`,
    }),
  });
  const body = await json(registered);
  if (!registered.ok) {
    console.error("register failed", wanted.filename, body);
    continue;
  }
  created.push(id);
  console.log("asset", id, wanted.filename);
}

// Attach to the first post so the list thumbnail, the media field and the
// gallery field all have real content.
const posts = await fetch(`${CMS}/api/records?modelApiKey=post`).then(json);
const firstPost = Array.isArray(posts) && posts.length > 0 && typeof posts[0] === "object" && posts[0] !== null
  ? Reflect.get(posts[0], "id")
  : null;

if (typeof firstPost === "string" && created.length > 0) {
  const patched = await fetch(`${CMS}/api/records/${firstPost}?modelApiKey=post`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelApiKey: "post",
      data: { cover_image: created[0], gallery: created.slice(0, 3) },
    }),
  });
  console.log("attached to post", firstPost, patched.status);
  if (!patched.ok) console.error(await json(patched));
}
