/**
 * The host's own form inputs. agent-cms ships none (ADR 0006) — these are
 * plain controlled inputs with a slot for the `issues[]` the dry-run
 * validation procedure returns for that field.
 */
import type { ReactNode } from "react";
import { issueMessage, type FieldIssue } from "../lib/errors.js";

export interface FieldProps {
  readonly label: string;
  readonly issues: readonly FieldIssue[];
  readonly children: ReactNode;
  readonly hint?: string;
}

export function Field({ label, issues, children, hint }: FieldProps) {
  return (
    <div className={issues.length > 0 ? "field field--invalid" : "field"}>
      <label className="field__label">{label}</label>
      {children}
      {hint && <p className="field__hint">{hint}</p>}
      {issues.map((issue, index) => (
        <p key={index} className="field__error" role="alert">
          {issueMessage(issue)}
          {issue.code && <span className="field__code">{issue.code}</span>}
        </p>
      ))}
    </div>
  );
}

export function TextInput(props: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly multiline?: boolean;
  readonly type?: "text" | "date" | "number";
}) {
  if (props.multiline) {
    return (
      <textarea rows={4} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
    );
  }
  return (
    <input
      type={props.type ?? "text"}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    />
  );
}

export function BoolInput(props: {
  readonly value: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <input
      type="checkbox"
      checked={props.value}
      onChange={(event) => props.onChange(event.target.checked)}
    />
  );
}

export function RefChip(props: {
  readonly id: string | null;
  readonly label: string | null;
  readonly onPick: () => void;
  readonly onClear: () => void;
}) {
  return (
    <div className="refchip">
      <span>{props.id ? (props.label ?? props.id) : "—"}</span>
      <button type="button" onClick={props.onPick}>
        pick
      </button>
      {props.id && (
        <button type="button" onClick={props.onClear}>
          clear
        </button>
      )}
    </div>
  );
}
