# Architecture Decision Records

Durable records of decisions that shape agent-cms. Each ADR states the context, the decision,
and its consequences; superseding decisions get a new ADR that references the old one.

- [0001 — DatoCMS parity is the default; deviations must be whitelisted](0001-dato-parity-policy.md)
- [0002 — Block editor engine is Tiptap 3 (ProseMirror)](0002-block-editor-engine-tiptap.md)
- [0003 — DAST grammar: tableCell is paragraph+, marks include customMark_*](0003-dast-grammar-tablecell-and-custom-marks.md)
- [0004 — Typed RPC: generated result-rpc fragments, merged into the host app, in-process](0004-rpc-fragments-in-process.md)
- [0005 — RPC failure algebra: five cms/* tags, aggregated issues, BYO-auth](0005-failure-algebra.md)
- [0006 — No admin ships: headless editing primitives, presentation hints, RPC-backed lists](0006-headless-editing-and-presentation.md)

Related non-ADR references: `docs/plans/` for implementation plans; research notes behind these
decisions live in the local (untracked) wayfinder workspace and are summarized into the ADRs.
