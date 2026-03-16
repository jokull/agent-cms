/**
 * Compile GraphQL filter inputs to SQL WHERE clauses via @effect/sql.
 * Pushes filtering to the database instead of doing it in-memory.
 */
import { Effect } from "effect";
import { SqlClient } from "@effect/sql";

interface FilterInput {
  AND?: FilterInput[];
  OR?: FilterInput[];
  [field: string]: any;
}

/**
 * Build a SQL WHERE fragment from a GraphQL filter input.
 * Returns a sql template fragment that can be interpolated into a query.
 *
 * @param filter - The GraphQL filter input object
 * @param fieldIsLocalized - Function to check if a field stores JSON locale data
 * @param locale - Current locale for json_extract on localized fields
 */
export function compileFilter(
  sql: SqlClient.SqlClient,
  filter: FilterInput | undefined,
  fieldIsLocalized?: (field: string) => boolean,
  locale?: string
): ReturnType<typeof sql.unsafe> | null {
  if (!filter || Object.keys(filter).length === 0) return null;

  const conditions = buildConditions(sql, filter, fieldIsLocalized, locale);
  if (conditions.length === 0) return null;

  // We need to build the WHERE clause as a raw SQL string since
  // @effect/sql's sql.and() returns a Fragment that can't be used
  // with sql.unsafe() directly. Build parameterized SQL manually.
  return null; // Placeholder — see compileFilterToSql below
}

interface SqlCondition {
  sql: string;
  params: unknown[];
}

function isSqlCondition(v: SqlCondition | null): v is SqlCondition {
  return v !== null;
}

/**
 * Compile a filter to a SQL WHERE clause string + params array.
 * This is the practical version that works with sql.unsafe().
 */
export function compileFilterToSql(
  filter: FilterInput | undefined,
  opts?: {
    fieldIsLocalized?: (field: string) => boolean;
    locale?: string;
  }
): { where: string; params: any[] } | null {
  if (!filter || Object.keys(filter).length === 0) return null;

  const conditions = buildSqlConditions(filter, opts?.fieldIsLocalized, opts?.locale);
  if (conditions.length === 0) return null;

  const where = conditions.map((c) => c.sql).join(" AND ");
  const params = conditions.flatMap((c) => c.params);
  return { where, params };
}

function buildSqlConditions(
  filter: FilterInput,
  fieldIsLocalized?: (field: string) => boolean,
  locale?: string
): SqlCondition[] {
  const conditions: SqlCondition[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (key === "AND" && Array.isArray(value)) {
      const subConditions = value.map((f) => buildSqlConditions(f, fieldIsLocalized, locale));
      const parts = subConditions
        .map((sc) => {
          if (sc.length === 0) return null;
          const sql = sc.map((c) => c.sql).join(" AND ");
          const params = sc.flatMap((c) => c.params);
          return { sql: `(${sql})`, params };
        })
        .filter(isSqlCondition);

      if (parts.length > 0) {
        conditions.push({
          sql: `(${parts.map((p) => p.sql).join(" AND ")})`,
          params: parts.flatMap((p) => p.params),
        });
      }
      continue;
    }

    if (key === "OR" && Array.isArray(value)) {
      const subConditions = value.map((f) => buildSqlConditions(f, fieldIsLocalized, locale));
      const parts = subConditions
        .map((sc) => {
          if (sc.length === 0) return null;
          const sql = sc.map((c) => c.sql).join(" AND ");
          const params = sc.flatMap((c) => c.params);
          return { sql: `(${sql})`, params };
        })
        .filter(isSqlCondition);

      if (parts.length > 0) {
        conditions.push({
          sql: `(${parts.map((p) => p.sql).join(" OR ")})`,
          params: parts.flatMap((p) => p.params),
        });
      }
      continue;
    }

    if (typeof value !== "object" || value === null) continue;

    // Determine the column expression
    const col =
      fieldIsLocalized?.(key) && locale
        ? `json_extract("${key}", '$.${locale}')`
        : `"${key}"`;

    // value is already narrowed to non-null object by the check above
    for (const [op, expected] of Object.entries(value)) {
      if (expected === undefined) continue;

      switch (op) {
        case "eq": {
          // Handle boolean coercion for SQLite
          const val = typeof expected === "boolean" ? (expected ? 1 : 0) : expected;
          conditions.push({ sql: `${col} = ?`, params: [val] });
          break;
        }
        case "neq": {
          const val = typeof expected === "boolean" ? (expected ? 1 : 0) : expected;
          conditions.push({ sql: `${col} != ?`, params: [val] });
          break;
        }
        case "gt":
          conditions.push({ sql: `${col} > ?`, params: [expected] });
          break;
        case "lt":
          conditions.push({ sql: `${col} < ?`, params: [expected] });
          break;
        case "gte":
          conditions.push({ sql: `${col} >= ?`, params: [expected] });
          break;
        case "lte":
          conditions.push({ sql: `${col} <= ?`, params: [expected] });
          break;
        case "matches":
          // Plain string matches (case-insensitive LIKE)
          if (typeof expected === "string") {
            conditions.push({ sql: `${col} LIKE ?`, params: [`%${expected}%`] });
          }
          break;
        case "matchesObject":
          // DatoCMS-style { pattern, caseSensitive } object
          if (typeof expected === "object" && expected !== null && "pattern" in expected) {
            const obj = expected as { pattern: string; caseSensitive?: boolean };
            if (obj.caseSensitive) {
              // SQLite GLOB is case-sensitive
              conditions.push({ sql: `${col} GLOB ?`, params: [`*${obj.pattern}*`] });
            } else {
              conditions.push({ sql: `${col} LIKE ?`, params: [`%${obj.pattern}%`] });
            }
          }
          break;
        case "isBlank":
          if (expected) {
            conditions.push({ sql: `(${col} IS NULL OR ${col} = '')`, params: [] });
          } else {
            conditions.push({ sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] });
          }
          break;
        case "isPresent":
          if (expected) {
            conditions.push({ sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] });
          } else {
            conditions.push({ sql: `(${col} IS NULL OR ${col} = '')`, params: [] });
          }
          break;
        case "exists":
          if (expected) {
            conditions.push({ sql: `${col} IS NOT NULL`, params: [] });
          } else {
            conditions.push({ sql: `${col} IS NULL`, params: [] });
          }
          break;
        case "in":
          if (Array.isArray(expected) && expected.length > 0) {
            const placeholders = expected.map(() => "?").join(", ");
            conditions.push({ sql: `${col} IN (${placeholders})`, params: expected });
          }
          break;
        case "notIn":
          if (Array.isArray(expected) && expected.length > 0) {
            const placeholders = expected.map(() => "?").join(", ");
            conditions.push({ sql: `${col} NOT IN (${placeholders})`, params: expected });
          }
          break;
      }
    }
  }

  return conditions;
}

/**
 * Compile an orderBy array to a SQL ORDER BY clause.
 * Input: ["title_ASC", "views_DESC"]
 * Output: { orderBy: '"title" ASC, "views" DESC' }
 */
export function compileOrderBy(
  orderBy: string[] | undefined,
  opts?: {
    fieldIsLocalized?: (field: string) => boolean;
    locale?: string;
  }
): string | null {
  if (!orderBy || orderBy.length === 0) return null;

  const parts = orderBy
    .map((spec) => {
      const match = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!match) return null;
      const [, field, dir] = match;

      const col =
        opts?.fieldIsLocalized?.(field) && opts?.locale
          ? `json_extract("${field}", '$.${opts.locale}')`
          : `"${field}"`;

      return `${col} ${dir}`;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : null;
}
