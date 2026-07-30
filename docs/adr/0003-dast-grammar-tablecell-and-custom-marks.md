# ADR 0003: DAST grammar — tableCell is paragraph+, marks include customMark_*

Status: accepted (2026-07-29)

## Context

Two grammar defects surfaced while proving editor round-trip fidelity: `tableCell` permitted
paragraphs and raw inline nodes as siblings (unrepresentable in ProseMirror, silently destroyed
by Slate — no editor can round-trip it), and `MarkSchema` was a closed six-literal union while
DatoCMS content may carry project-defined `customMark_*` marks.

## Decision

- `tableCell.children` is `paragraph+` (NonEmptyArray of paragraphs). A survey of all stored
  DAST (282 documents across every local database) found zero offending cells, so no migration
  was needed; the markdown importer now writes empty cells as an empty paragraph instead of a
  paragraph holding an empty span.
- `Mark = DefaultMark | \`customMark_${string}\``. Custom marks are preserved through every
  serializer: the markdown/editable projections carry them as `<m k="...">` tags (mirroring
  datocms-structured-text-dastdown's own encoding); unknown non-prefixed marks stay rejected.
- Empty spans remain legal stored DAST (Dato-legal; rejecting would invalidate historic
  documents at read time). The editor codec drops them on load and never emits them.

## Consequences

The grammar is representable by ProseMirror with no lossy normalization. Editors (and the
agent-text round-trip, which previously corrupted non-default marks) share one mark vocabulary.
The editor bridge registers custom marks per field via config; content carrying an unregistered
custom mark fails loudly at load.
