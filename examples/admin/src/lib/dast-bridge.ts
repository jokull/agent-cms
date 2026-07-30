/**
 * The seam between two packages that each define DAST.
 *
 * `@agent-cms/editor-react` vendors its own DAST types where a span's marks are
 * `DefaultMark | \`customMark_${string}\``. The generated `contract.ts` vendors
 * a *third* copy where marks are the six defaults only. The result: the editor's
 * `onChange` document is NOT assignable to the generated envelope's `value`,
 * so a host cannot move a document from the toolkit into the client without
 * this adapter. FRICTION.md #1 — the single most expensive thing in this app.
 *
 * The adapter is honest rather than a cast: it strips any custom mark (which
 * the contract type says cannot exist) and then narrows with a type predicate.
 */
import type { DastDocument as EditorDastDocument } from "@agent-cms/editor-react";
import type { DastDocument as ContractDastDocument } from "../cms/contract.js";

const DEFAULT_MARKS: ReadonlySet<string> = new Set([
  "strong",
  "emphasis",
  "underline",
  "strikethrough",
  "code",
  "highlight",
]);

/** Deep copy with `customMark_*` removed from every span. */
function stripCustomMarks(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripCustomMarks);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "marks" && Array.isArray(value)) {
      out[key] = value.filter((mark) => typeof mark === "string" && DEFAULT_MARKS.has(mark));
      continue;
    }
    out[key] = stripCustomMarks(value);
  }
  return out;
}

function everyMarkIsDefault(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(everyMarkIsDefault);
  if (typeof node !== "object" || node === null) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === "marks" && Array.isArray(value)) {
      if (!value.every((mark) => typeof mark === "string" && DEFAULT_MARKS.has(mark))) return false;
      continue;
    }
    if (!everyMarkIsDefault(value)) return false;
  }
  return true;
}

/**
 * A user-defined type guard, not a cast: the narrowed type is an intersection
 * of the input type, so TypeScript accepts it and the runtime check is real.
 */
function isContractShaped(
  document: EditorDastDocument,
): document is EditorDastDocument & ContractDastDocument {
  return everyMarkIsDefault(document.document);
}

const EMPTY: ContractDastDocument = {
  schema: "dast",
  document: { type: "root", children: [{ type: "paragraph", children: [] }] },
};

export function toContractDocument(document: EditorDastDocument): ContractDastDocument {
  if (isContractShaped(document)) return document;
  const stripped = stripCustomMarks(document);
  // `stripped` is structurally the same document minus custom marks; re-narrow
  // through the same guard rather than asserting.
  if (isEditorDocument(stripped) && isContractShaped(stripped)) return stripped;
  return EMPTY;
}

function isEditorDocument(value: unknown): value is EditorDastDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    "schema" in value &&
    value.schema === "dast" &&
    "document" in value
  );
}
