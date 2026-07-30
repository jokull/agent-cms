# ADR 0002: Block editor engine is Tiptap 3 (ProseMirror)

Status: accepted (2026-07-29)

## Context

`structured_text` is the one field type a consumer cannot bring themselves. Candidates:
ProseMirror (via Tiptap 3), Lexical, Slate, BlockNote — evaluated against the DAST document
model (`src/dast/schema.ts`), which is a production content *grammar* (blockquote accepts only
paragraphs, listItem only paragraph-or-list, tableCell only paragraphs, links only spans).

## Decision

Tiptap 3 (all-MIT at 3.29.2). The decisive reason is not editor features: **DAST is a content
grammar and ProseMirror's `NodeSpec.content` expressions are the only candidate document model
that is also a grammar.** The DAST grammar compiles 1:1 into node specs, enforced by the
engine; everywhere else those constraints become hand-maintained imperative repair code.

Supporting reasons: invalid content fails loudly (`enableContentCheck: true` is mandatory —
Tiptap otherwise logs and silently drops schema-violating nodes; Slate's normalizer silently
deletes); the codegen-emitted static block union matches PM's immutable schema model; genuinely
headless (zero required CSS/chrome); DAST `block`/`inlineBlock` map 1:1 to PM atom nodes.

Runner-up Slate lost on silent data loss, dead Yjs binding, half-published prior art
(`slateToDast` with no inverse, pinned four years back), and project health. BlockNote cannot
represent `blockquote > paragraph`; Lexical has no declarative schema and a closed mark
bitmask. Measured bundle: Tiptap ~139 KB gz for the needed set.

## Consequences

The editor toolkit lives in `packages/editor-react`: a `/bridge` layer (extensions = the DAST
grammar + a lossless DAST↔PM codec) and headless React hooks on top. Deliberate normalizations:
empty spans are dropped on load and never emitted; adjacent identical marks merge. Tiptap is
VC-funded — pin versions and consider vendoring the few extensions used. Tables have no
upstream reference; the table codec and commands are ours.
