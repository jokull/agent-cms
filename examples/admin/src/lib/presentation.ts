/**
 * Presentation hints, hand-rolled.
 *
 * ADR 0006 says models carry `title_field` / `image_preview_field` and that
 * codegen computes deterministic fallbacks at generation time — but nothing
 * about them reaches `contract.ts`, so a host list view cannot render
 * "image + title" generically. These two functions are the workaround, and
 * they are hard-coded per model. See FRICTION.md #2.
 */
import type { MediaValue, Post } from "../cms/contract.js";

export function postTitle(record: Pick<Post, "title" | "id">): string {
  return record.title.length > 0 ? record.title : record.id;
}

/** A MediaValue is an asset id OR an upload descriptor; narrow without a cast. */
export function mediaId(value: MediaValue | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return value.upload_id;
}

export function mediaFrom(id: string | null): MediaValue | undefined {
  return id === null || id.length === 0 ? undefined : id;
}
