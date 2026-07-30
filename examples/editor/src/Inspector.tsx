import type { DastDocument } from "@agent-cms/editor-react";

export interface InspectorProps {
  document: DastDocument;
}

/** Live view of the DAST document as it round-trips through onChange. */
export function Inspector({ document }: InspectorProps) {
  return (
    <aside className="inspector">
      <h2>DAST document</h2>
      <pre>{JSON.stringify(document, null, 2)}</pre>
    </aside>
  );
}
