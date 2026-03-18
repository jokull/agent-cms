/**
 * Compile GraphQL filter inputs to SQL WHERE clauses.
 * Pushes filtering to the database instead of doing it in-memory.
 *
 * Supports:
 * - Scalar operators: eq, neq, gt, lt, gte, lte, in, notIn
 * - String operators: matches (string or {pattern, caseSensitive}), notMatches, isBlank, isPresent
 * - Existence: exists
 * - JSON array operators: allIn, anyIn (for links/gallery columns stored as JSON arrays)
 * - Geolocation: near ({latitude, longitude, radius}) using bounding-box approximation
 * - Locale filter: _locales (allIn, anyIn, notIn) across localized columns
 * - Logical: AND, OR (nestable)
 */

interface FilterInput {
  AND?: FilterInput[];
  OR?: FilterInput[];
  [field: string]: unknown;
}

interface SqlCondition {
  sql: string;
  params: unknown[];
}

function isFilterInput(value: unknown): value is FilterInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPrimitiveArray(value: unknown): value is Array<string | number | boolean | null> {
  return Array.isArray(value)
    && value.every((item) =>
      typeof item === "string"
      || typeof item === "number"
      || typeof item === "boolean"
      || item === null);
}

function isSqlCondition(v: SqlCondition | null): v is SqlCondition {
  return v !== null;
}

export interface FilterCompilerOpts {
  /** Check if a camelCase field name is localized (stores JSON locale map) */
  fieldIsLocalized?: (field: string) => boolean;
  /** Map camelCase GraphQL names → snake_case DB column names */
  fieldNameMap?: Record<string, string>;
  /** Current locale for json_extract on localized fields */
  locale?: string;
  /** DB column names (snake_case) of all localized fields — needed for _locales filter */
  localizedDbColumns?: string[];
  /** Set of camelCase field names that store JSON arrays (links, media_gallery) */
  jsonArrayFields?: Set<string>;
}

/**
 * Compile a filter to a SQL WHERE clause string + params array.
 * Returns null when the filter is empty.
 */
export function compileFilterToSql(
  filter: FilterInput | undefined,
  opts?: FilterCompilerOpts
): { where: string; params: unknown[] } | null {
  if (!filter || Object.keys(filter).length === 0) return null;

  const conditions = buildSqlConditions(filter, opts);
  if (conditions.length === 0) return null;

  const where = conditions.map((c) => c.sql).join(" AND ");
  const params = conditions.flatMap((c) => c.params);
  return { where, params };
}

// Map GraphQL camelCase system fields to snake_case DB columns
const META_COLUMN_MAP: Record<string, string> = {
  _createdAt: "_created_at",
  _updatedAt: "_updated_at",
  _publishedAt: "_published_at",
  _firstPublishedAt: "_first_published_at",
  _status: "_status",
  _parent: "_parent_id",
  _position: "_position",
};

function resolveDbKey(key: string, opts?: FilterCompilerOpts): string {
  return META_COLUMN_MAP[key] ?? opts?.fieldNameMap?.[key] ?? key;
}

function resolveCol(key: string, dbKey: string, opts?: FilterCompilerOpts): string {
  return opts?.fieldIsLocalized?.(key) && opts?.locale
    ? `json_extract("${dbKey}", '$.${opts.locale}')`
    : `"${dbKey}"`;
}

function buildSqlConditions(
  filter: FilterInput,
  opts?: FilterCompilerOpts
): SqlCondition[] {
  const conditions: SqlCondition[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    // --- Logical operators ---
    if (key === "AND" && Array.isArray(value)) {
      const parts = value
        .filter(isFilterInput)
        .map((f) => buildSqlConditions(f, opts))
        .map((sc) => {
          if (sc.length === 0) return null;
          return { sql: `(${sc.map((c) => c.sql).join(" AND ")})`, params: sc.flatMap((c) => c.params) };
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
      const parts = value
        .filter(isFilterInput)
        .map((f) => buildSqlConditions(f, opts))
        .map((sc) => {
          if (sc.length === 0) return null;
          return { sql: `(${sc.map((c) => c.sql).join(" AND ")})`, params: sc.flatMap((c) => c.params) };
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

    // --- _locales special filter ---
    if (key === "_locales" && typeof value === "object" && value !== null) {
      const locCols = opts?.localizedDbColumns ?? [];
      if (locCols.length > 0) {
        const locCondition = compileLocalesFilter(value as Record<string, unknown>, locCols);
        if (locCondition) conditions.push(locCondition);
      }
      continue;
    }

    if (typeof value !== "object" || value === null) continue;

    const dbKey = resolveDbKey(key, opts);
    const col = resolveCol(key, dbKey, opts);

    const isJsonArray = opts?.jsonArrayFields?.has(key) ?? false;

    for (const [op, expected] of Object.entries(value as Record<string, unknown>)) {
      if (expected === undefined) continue;
      const cond = compileOperator(op, expected, col, dbKey, isJsonArray);
      if (cond) conditions.push(cond);
    }
  }

  return conditions;
}

/**
 * Compile a single operator into a SQL condition.
 * `col` is the quoted column expression (may include json_extract for localized fields).
 * `dbKey` is the raw DB column name (used for json_extract in array/geo operators).
 */
function compileOperator(
  op: string,
  expected: unknown,
  col: string,
  dbKey: string,
  isJsonArray: boolean = false
): SqlCondition | null {
  switch (op) {
    // --- Scalar comparison ---
    case "eq": {
      if (isJsonArray && Array.isArray(expected)) {
        // Exact JSON array match (for links/gallery): same elements, same order
        const json = JSON.stringify(expected);
        return { sql: `${col} = ?`, params: [json] };
      }
      const val = typeof expected === "boolean" ? (expected ? 1 : 0) : expected;
      return { sql: `${col} = ?`, params: [val] };
    }
    case "neq": {
      const val = typeof expected === "boolean" ? (expected ? 1 : 0) : expected;
      return { sql: `${col} != ?`, params: [val] };
    }
    case "gt":
      return { sql: `${col} > ?`, params: [expected] };
    case "lt":
      return { sql: `${col} < ?`, params: [expected] };
    case "gte":
      return { sql: `${col} >= ?`, params: [expected] };
    case "lte":
      return { sql: `${col} <= ?`, params: [expected] };

    // --- Set membership (scalar column) ---
    case "in":
      if (isPrimitiveArray(expected) && expected.length > 0) {
        const ph = expected.map(() => "?").join(", ");
        return { sql: `${col} IN (${ph})`, params: expected };
      }
      return null;
    case "notIn":
      if (isPrimitiveArray(expected) && expected.length > 0) {
        if (isJsonArray) {
          // For JSON array columns: none of the specified values appear in the array
          const ph = expected.map(() => "?").join(", ");
          return {
            sql: `NOT EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${ph}))`,
            params: expected,
          };
        }
        const ph = expected.map(() => "?").join(", ");
        return { sql: `${col} NOT IN (${ph})`, params: expected };
      }
      return null;

    // --- JSON array operators (links/gallery columns stored as JSON arrays) ---
    case "allIn":
      if (isPrimitiveArray(expected) && expected.length > 0) {
        const ph = expected.map(() => "?").join(", ");
        return {
          sql: `(SELECT COUNT(DISTINCT value) FROM json_each(${col}) WHERE value IN (${ph})) = ?`,
          params: [...expected, expected.length],
        };
      }
      return null;
    case "anyIn":
      if (isPrimitiveArray(expected) && expected.length > 0) {
        const ph = expected.map(() => "?").join(", ");
        return {
          sql: `EXISTS (SELECT 1 FROM json_each(${col}) WHERE value IN (${ph}))`,
          params: expected,
        };
      }
      return null;

    // --- String matching ---
    case "matches":
      if (typeof expected === "string") {
        return { sql: `${col} LIKE ?`, params: [`%${expected}%`] };
      }
      // DatoCMS-style { pattern, caseSensitive } object
      if (typeof expected === "object" && expected !== null && "pattern" in expected) {
        const obj = expected as Record<string, unknown>;
        if (obj.caseSensitive) {
          return { sql: `${col} GLOB ?`, params: [`*${String(obj.pattern)}*`] };
        }
        return { sql: `${col} LIKE ?`, params: [`%${String(obj.pattern)}%`] };
      }
      return null;
    case "notMatches":
      if (typeof expected === "string") {
        return { sql: `${col} NOT LIKE ?`, params: [`%${expected}%`] };
      }
      if (typeof expected === "object" && expected !== null && "pattern" in expected) {
        const obj = expected as Record<string, unknown>;
        if (obj.caseSensitive) {
          return { sql: `${col} NOT GLOB ?`, params: [`*${String(obj.pattern)}*`] };
        }
        return { sql: `${col} NOT LIKE ?`, params: [`%${String(obj.pattern)}%`] };
      }
      return null;

    // --- Blank / Present / Exists ---
    case "isBlank":
      return expected
        ? { sql: `(${col} IS NULL OR ${col} = '')`, params: [] }
        : { sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] };
    case "isPresent":
      return expected
        ? { sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] }
        : { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
    case "exists":
      return expected
        ? { sql: `${col} IS NOT NULL`, params: [] }
        : { sql: `${col} IS NULL`, params: [] };

    // --- Geolocation: near { latitude, longitude, radius } ---
    case "near": {
      if (typeof expected !== "object" || expected === null) return null;
      const geo = expected as Record<string, unknown>;
      const latitude = typeof geo.latitude === "number" ? geo.latitude : undefined;
      const longitude = typeof geo.longitude === "number" ? geo.longitude : undefined;
      const radius = typeof geo.radius === "number" ? geo.radius : undefined;
      if (latitude == null || longitude == null || radius == null) return null;

      // Bounding-box approximation: 1° latitude ≈ 111,320 meters
      const latDelta = radius / 111320;
      const lonDelta = radius / (111320 * Math.cos((latitude * Math.PI) / 180));
      const latMin = latitude - latDelta;
      const latMax = latitude + latDelta;
      const lonMin = longitude - lonDelta;
      const lonMax = longitude + lonDelta;

      // lat_lon columns are JSON objects: {"latitude": N, "longitude": N}
      const latExpr = `json_extract("${dbKey}", '$.latitude')`;
      const lonExpr = `json_extract("${dbKey}", '$.longitude')`;

      return {
        sql: `(${latExpr} BETWEEN ? AND ? AND ${lonExpr} BETWEEN ? AND ?)`,
        params: [latMin, latMax, lonMin, lonMax],
      };
    }

    // Legacy: matchesObject (kept for backwards compat, prefer unified "matches")
    case "matchesObject":
      if (typeof expected === "object" && expected !== null && "pattern" in expected) {
        const obj = expected as Record<string, unknown>;
        if (obj.caseSensitive) {
          return { sql: `${col} GLOB ?`, params: [`*${String(obj.pattern)}*`] };
        }
        return { sql: `${col} LIKE ?`, params: [`%${String(obj.pattern)}%`] };
      }
      return null;

    default:
      return null;
  }
}

/**
 * Compile _locales filter across all localized columns.
 *
 * _locales: { anyIn: ["en"] }  → any localized field has a non-null value for "en"
 * _locales: { allIn: ["en", "is"] } → every locale has at least one non-null value
 * _locales: { notIn: ["de"] }  → no localized field has a value for "de"
 */
function compileLocalesFilter(
  value: Record<string, unknown>,
  localizedDbColumns: string[]
): SqlCondition | null {
  const allIn = Array.isArray(value.allIn) ? value.allIn as string[] : undefined;
  const anyIn = Array.isArray(value.anyIn) ? value.anyIn as string[] : undefined;
  const notIn = Array.isArray(value.notIn) ? value.notIn as string[] : undefined;

  const parts: SqlCondition[] = [];

  if (anyIn && Array.isArray(anyIn) && anyIn.length > 0) {
    // For each requested locale, at least one localized field must have a non-null value
    for (const locale of anyIn) {
      const orParts = localizedDbColumns.map(
        (col) => `(json_extract("${col}", '$.${locale}') IS NOT NULL AND json_extract("${col}", '$.${locale}') != '')`
      );
      parts.push({ sql: `(${orParts.join(" OR ")})`, params: [] });
    }
  }

  if (allIn && Array.isArray(allIn) && allIn.length > 0) {
    // Every requested locale must have content in at least one field
    for (const locale of allIn) {
      const orParts = localizedDbColumns.map(
        (col) => `(json_extract("${col}", '$.${locale}') IS NOT NULL AND json_extract("${col}", '$.${locale}') != '')`
      );
      parts.push({ sql: `(${orParts.join(" OR ")})`, params: [] });
    }
  }

  if (notIn && Array.isArray(notIn) && notIn.length > 0) {
    // None of the requested locales should have content in any field
    for (const locale of notIn) {
      const andParts = localizedDbColumns.map(
        (col) => `(json_extract("${col}", '$.${locale}') IS NULL OR json_extract("${col}", '$.${locale}') = '')`
      );
      parts.push({ sql: `(${andParts.join(" AND ")})`, params: [] });
    }
  }

  if (parts.length === 0) return null;
  return {
    sql: parts.map((p) => p.sql).join(" AND "),
    params: parts.flatMap((p) => p.params),
  };
}

/**
 * Compile an orderBy array to a SQL ORDER BY clause.
 * Input: ["title_ASC", "views_DESC"]
 * Output: '"title" ASC, "views" DESC'
 */
export function compileOrderBy(
  orderBy: string[] | undefined,
  opts?: FilterCompilerOpts
): string | null {
  if (!orderBy || orderBy.length === 0) return null;

  const parts = orderBy
    .map((spec) => {
      const match = spec.match(/^(.+)_(ASC|DESC)$/);
      if (!match) return null;
      const [, field, dir] = match;

      const dbField = META_COLUMN_MAP[field] ?? opts?.fieldNameMap?.[field] ?? field;

      const col =
        opts?.fieldIsLocalized?.(field) && opts?.locale
          ? `json_extract("${dbField}", '$.${opts.locale}')`
          : `"${dbField}"`;

      return `${col} ${dir}`;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(", ") : null;
}
