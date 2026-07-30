/**
 * Shared helpers for building safe SQL text-matching predicates from
 * user-supplied search strings.
 *
 * SQLite `LIKE` treats `%` and `_` as wildcards; `GLOB` treats `*`, `?`, and
 * `[...]` as wildcards. Without escaping, user text containing these
 * characters silently changes matching behavior (a literal `_` matches any
 * single character, `%` matches everything) instead of being matched as
 * literal text.
 *
 * Dependency-free by design so both `src/graphql/` and `src/services/` can
 * import it without pulling in Effect or any DB client.
 */

/** Escape LIKE metacharacters (`\`, `%`, `_`) in `value` so they match literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Escape GLOB metacharacters (`*`, `?`, `[`, `]`) in `value` so they match literally. */
export function escapeGlob(value: string): string {
  return value.replace(/[*?[\]]/g, (c) => `[${c}]`);
}

export interface PatternMatch {
  /** SQL fragment, e.g. `"col" LIKE ? ESCAPE '\'` or `"col" NOT GLOB ?`. */
  sql: string;
  /** Bound parameter — the escaped, wildcard-wrapped pattern. */
  param: string;
}

/**
 * Build a substring-match SQL fragment + parameter for `col`, safely escaping
 * `value` so any LIKE/GLOB metacharacters it contains are matched literally
 * rather than treated as wildcards.
 *
 * - `caseSensitive: false` (default): `LIKE ... ESCAPE '\'` (ASCII case-insensitive).
 * - `caseSensitive: true`: `GLOB` (case-sensitive), escaping `* ? [ ]` via bracket classes.
 * - `negated: true`: produces `NOT LIKE` / `NOT GLOB`.
 */
export function buildPatternMatch(
  col: string,
  value: string,
  opts?: { caseSensitive?: boolean; negated?: boolean },
): PatternMatch {
  const negated = opts?.negated ?? false;
  if (opts?.caseSensitive) {
    return { sql: `${col} ${negated ? "NOT GLOB" : "GLOB"} ?`, param: `*${escapeGlob(value)}*` };
  }
  return {
    sql: `${col} ${negated ? "NOT LIKE" : "LIKE"} ? ESCAPE '\\'`,
    param: `%${escapeLike(value)}%`,
  };
}

/** Wrap an already-escaped LIKE pattern in `%...%` wildcards (contains-match). */
export function likeContains(value: string): string {
  return `%${escapeLike(value)}%`;
}
