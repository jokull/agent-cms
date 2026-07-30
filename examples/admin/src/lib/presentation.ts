/**
 * Media-value helpers for the *form* controls.
 *
 * "Which field titles this model, which one previews it" is no longer answered
 * here: codegen emits a `ModelPresentation` per model (`POST_PRESENTATION`,
 * `PRESENTATION[apiKey]`) with the fallback resolved at generation time, and
 * `presentRecord(record, presentation)` renders any record as the same row
 * shape `search` returns. See FRICTION.md #2 (resolved).
 */
import type { MediaValue } from "../cms/contract.js";

/**
 * The canonical URL a read carries on every media value. Write-shaped values
 * (a bare asset id the user just typed) have none yet — then there is nothing
 * to render until the record round-trips.
 */
export function mediaUrl(value: MediaValue | null | undefined): string | null {
  if (value === null || value === undefined || typeof value === "string") return null;
  return value.url ?? null;
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
