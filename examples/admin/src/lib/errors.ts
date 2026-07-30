/**
 * One message catalog for the whole app, keyed by tag. The CMS contributes the
 * five `cms/*` tags (ADR 0005); the host contributes `auth/unauthorized`.
 * `cms/schema-drift` never reaches a component — CmsShell claims it.
 */
import { cmsErrors } from "@agent-cms/codegen/errors";
import type { AnyTaggedError } from "result-rpc";

export interface FieldIssue {
  readonly field?: string;
  readonly message: string;
  readonly code?: string;
}

export function describeError(error: AnyTaggedError): string {
  if (cmsErrors.validationFailed.is(error)) {
    return error.data.issues
      .map((issue) => (issue.field ? `${issue.field}: ${issue.message}` : issue.message))
      .join(" · ");
  }
  if (cmsErrors.recordNotFound.is(error)) return `Record ${error.data.id} no longer exists`;
  if (cmsErrors.duplicate.is(error)) return error.data.message;
  if (cmsErrors.referenceConflict.is(error)) {
    return `Still referenced by ${error.data.references.length} record(s)`;
  }
  if (cmsErrors.schemaDrift.is(error)) {
    return `Stale build — regenerate src/cms (${error.data.procedure})`;
  }
  if (error._tag === "auth/unauthorized") return "Signed out — mutations are blocked";
  return error._tag;
}

/** Pull `issues[]` off a failure when it is a validation failure; else empty. */
export function issuesOf(error: AnyTaggedError | undefined): readonly FieldIssue[] {
  if (error === undefined) return [];
  return cmsErrors.validationFailed.is(error) ? error.data.issues : [];
}

/** Index issues by field so a form can render them next to inputs. */
export function issuesByField(
  issues: readonly FieldIssue[],
): ReadonlyMap<string, readonly FieldIssue[]> {
  const map = new Map<string, FieldIssue[]>();
  for (const issue of issues) {
    const key = issue.field ?? "";
    const bucket = map.get(key);
    if (bucket) bucket.push(issue);
    else map.set(key, [issue]);
  }
  return map;
}

/** `code`-driven copy where the server's prose is too raw for a form. */
export function issueMessage(issue: FieldIssue): string {
  switch (issue.code) {
    case "required":
      return "Required";
    case "unique":
      return "Already taken";
    case "format":
      return "Wrong format";
    case "enum":
      return "Not an allowed value";
    case "length":
      return "Wrong length";
    case "range":
      return "Out of range";
    case "link_target":
      return "Points at a record of the wrong model";
    case "block_type":
      return "Block type not allowed in this field";
    case "structured_text":
      return `Structured text: ${issue.message}`;
    default:
      return issue.message;
  }
}
