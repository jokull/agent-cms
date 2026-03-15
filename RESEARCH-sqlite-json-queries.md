# SQLite JSON Functions + @effect/sql Query Building

Research for agent-cms dynamic query layer. All patterns verified for D1 (SQLite 3.42+).

## SQLite JSON Functions on D1

All JSON1 functions work. `json_extract` is the workhorse — usable in SELECT, WHERE, ORDER BY, JOIN ON, and index expressions.

```sql
-- Localization: extract locale from JSON column
SELECT json_extract(title, '$.en') AS title FROM content_post
WHERE json_extract(title, '$.en') LIKE '%search%'
ORDER BY json_extract(title, '$.en');

-- Media gallery: JOIN against assets via json_each
SELECT p.id, a.url
FROM content_post p, json_each(p.media) AS je
JOIN assets a ON a.id = je.value;

-- Published snapshot: read from snapshot vs real columns
-- includeDrafts=false:
SELECT json_extract(_published_snapshot, '$.title') AS title FROM content_post WHERE _status IN ('published', 'updated')
-- includeDrafts=true:
SELECT title FROM content_post
```

## D1 JSON Indexes

Both approaches work. Generated columns are recommended:

```sql
-- Expression index (works on D1)
CREATE INDEX idx_title_en ON content_post(json_extract(title, '$.en'));

-- Generated column + index (cleaner, zero storage for VIRTUAL)
ALTER TABLE content_post
ADD COLUMN title_en TEXT GENERATED ALWAYS AS (json_extract(title, '$.en')) VIRTUAL;
CREATE INDEX idx_title_en ON content_post(title_en);
```

For a CMS with known locales, generate a virtual column per indexed locale at migration time.

## @effect/sql Dynamic WHERE Building

Key primitives from `@effect/sql`:
- `sql.and(fragments[])` — joins with AND, wraps in parens, returns `1=1` when empty
- `sql.or(fragments[])` — joins with OR, wraps in parens, returns `1=1` when empty
- `sql\`...\`` — template tag, interpolated values become bound parameters
- `sql("name")` — identifier (quoted column/table name)
- `sql.literal("raw")` — raw trusted SQL, no escaping
- `sql.in(values[])` — expands to `(?, ?, ?)`

```typescript
// Dynamic WHERE composition
const conditions: Statement.Fragment[] = []

if (!includeDrafts) {
  conditions.push(sql`_status IN ('published', 'updated')`)
}
if (search) {
  conditions.push(sql`json_extract(title, '$.en') LIKE ${"%" + search + "%"}`)
}

const where = conditions.length > 0
  ? sql`WHERE ${sql.and(conditions)}`
  : sql.literal("")

const rows = yield* sql`SELECT * FROM ${sql(table)} ${where} LIMIT ${limit}`
```

## Filter → SQL Compiler Pattern

Map GraphQL field names to SQL expressions (handles JSON columns transparently):

```typescript
function buildFilter(sql, filter, locale): Statement.Fragment {
  const conditions: Statement.Fragment[] = []

  for (const [key, value] of Object.entries(filter)) {
    if (key === "AND") {
      conditions.push(sql.and(value.map(f => buildFilter(sql, f, locale))))
      continue
    }
    if (key === "OR") {
      conditions.push(sql.or(value.map(f => buildFilter(sql, f, locale))))
      continue
    }

    // For localized fields, use json_extract; for regular, use column directly
    const col = isLocalized(key)
      ? sql.literal(`json_extract(${key}, '$.${locale}')`)
      : sql`${sql(key)}`

    const f = value as ScalarFilter
    if (f.eq !== undefined)   conditions.push(sql`${col} = ${f.eq}`)
    if (f.neq !== undefined)  conditions.push(sql`${col} != ${f.neq}`)
    if (f.gt !== undefined)   conditions.push(sql`${col} > ${f.gt}`)
    if (f.lt !== undefined)   conditions.push(sql`${col} < ${f.lt}`)
    if (f.gte !== undefined)  conditions.push(sql`${col} >= ${f.gte}`)
    if (f.lte !== undefined)  conditions.push(sql`${col} <= ${f.lte}`)
    if (f.matches !== undefined) conditions.push(sql`${col} LIKE ${"%" + f.matches + "%"}`)
    if (f.exists === true)  conditions.push(sql`${col} IS NOT NULL`)
    if (f.exists === false) conditions.push(sql`${col} IS NULL`)
    if (f.isBlank === true) conditions.push(sql`(${col} IS NULL OR ${col} = '')`)
  }

  return conditions.length > 0 ? sql.and(conditions) : sql.literal("1=1")
}
```

## D1 Limits

| Constraint | Limit | Impact |
|---|---|---|
| Bound parameters per query | **100** | Each IN element counts. Guard in filter builder. |
| Row size | 2 MB | JSON snapshot + all locales share this. |
| No transactions | N/A | Use D1 `db.batch()` for atomic operations. |
| Queries per invocation | 50 free / 1000 paid | Watch for N+1 in json_each JOINs. |
