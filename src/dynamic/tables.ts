/**
 * Content-table naming — the root of the untyped SQL layer.
 *
 * Every content-table reference in the codebase is built from a model's
 * api_key via this function, so the construction lives in the zone and
 * nowhere else. Model api_keys are snake_case identifiers validated at
 * model creation; the check here is defense-in-depth so a crafted key can
 * never reach SQL, quoted or not.
 */
export function contentTableName(modelApiKey: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(modelApiKey)) {
    throw new Error(`Invalid model api_key for content table: ${JSON.stringify(modelApiKey)}`);
  }
  return `content_${modelApiKey}`;
}
