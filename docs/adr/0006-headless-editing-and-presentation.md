# ADR 0006: No admin ships — headless editing primitives, presentation hints, RPC-backed list/search

Status: accepted (2026-07-29)

## Context

The motivating consumer weaves CMS editing into an admin that already exists, alongside
non-CMS data. Earlier efforts assuming a shipped admin GUI were abandoned (a generic renderer
loops over schema and erases the static types that are the whole point).

## Decision

- **No admin CRUD GUI ships, ever.** agent-cms supplies types, mutations, editing state, and
  the one irreducible component (the block editor engine layer). Toolbars, forms, pickers,
  modals, styling: host-owned. The editor toolkit ships zero CSS and no chrome; block payloads
  render through host-supplied, codegen-typed components.
- **Models carry presentation hints** (`title_field`, `image_preview_field` — Dato parity,
  validated against real fields, cleared when the referenced field is deleted, round-tripped
  through schema export/import) so record lists, pickers, and link chips can render
  "image + title" rows generically. Codegen computes deterministic fallbacks at generation
  time (title/name/heading/label → first string; first media field).
- **The RPC surface is self-sufficient for admin list views**: filtered/paginated/sorted
  `list` (the GraphQL filter vocabulary, reused via the shared filter compiler), model-scoped
  picker `search` returning presentation rows, `syncState`, versions, scheduling, backlinks,
  bulk ops, and a shared `assets.*` namespace (uploads stay out of band via presigned URLs).
  GraphQL remains the shaped-delivery read path for sites (field selection, deep reverse
  references).

## Consequences

A host admin can reach Dato-GUI parity for editing flows with only its own components. The
deliberately deferred remainder: selective publish of nested references, asset collections,
image crop/rotate (use Cloudflare Image Resizing), server-side saved filters, editing-session
presence.
