# ADR 0001: DatoCMS parity is the default; deviations must be whitelisted

Status: accepted (2026-07-29)

## Context

agent-cms's motivating deployment is a live migration off DatoCMS (editors, content, and an
in-house admin already exist). Schemas and content arrive shaped the way Dato's CMA shapes
them; silent rejections or dropped constraints would corrupt the migration.

## Decision

A schema or content payload shaped the way DatoCMS's CMA shapes it must be accepted —
normalized where our internal encoding differs. Deviations from Dato behavior are treated as
bugs unless explicitly whitelisted. Input is liberal, storage is canonical: wrapped validator
encodings (`enum: {values}`, `*_item_type`/`*_blocks`: `{item_types}`), Dato-style boolean
validators (`required: {}`), and model-ID item-type references all normalize to bare arrays of
api_keys before validation and storage. The DAST mark set accepts `customMark_${string}`.
`structured_text_links` and `structured_text_inline_blocks` exist and are enforced.

**Whitelisted deviations:**
- GraphQL uses snake_case field names matching `api_key` (deliberate).
- Structured-text tables (`table`/`tableRow`/`tableCell`) — a superset of Dato's DAST; content
  using them cannot round-trip through Dato tooling.
- `slug_source` (field api_key string) instead of Dato's `slug_title_field` (field ID).
- Inline blocks fall back to the `structured_text_blocks` whitelist when
  `structured_text_inline_blocks` is absent (Dato requires the validator for inline blocks).
- Custom marks require the `customMark_` prefix (upstream typings allow bare strings).
- agent-cms REST is its own API, not a CMA clone — parity applies to validator vocabulary,
  DAST, and schema import, not REST route shapes.
- Saved filters are host-side state (Dato stores them server-side as `item-type-filters`).
- Deletes are synchronous (Dato's are async 202 jobs).

## Consequences

When touching validators, DAST, or schema import: check the Dato CMA encoding first and accept
both forms (pattern: `normalizeBooleanValidators` / `unwrapWrappedListValidators` /
`normalizeItemTypeValidators` in field-service). Surface any new divergence for an explicit
whitelist decision rather than shipping it silently.
