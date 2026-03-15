# DatoCMS GraphQL API — Exact Specifications

Research for building a compatible Content Delivery API.

## 1. includeDrafts / Preview Mode

**Mechanism:** HTTP header `X-Include-Drafts: true`, NOT a query argument.

| Record State | Default (no header) | With `X-Include-Drafts: true` |
|---|---|---|
| `draft` | Not returned | Returned (draft version) |
| `published` | Published version | Published version |
| `updated` | Published version only | Draft version (unpublished changes) |

**`_status` field:** Only meaningful with `X-Include-Drafts: true`. Values: `"draft"`, `"published"`, `"updated"`.

**Key insight for our implementation:** Without the header, only return records where `_status` is `published` or `updated`, and read from `_published_snapshot`. With the header, return all records and read from real columns.

## 2. Locale Handling

**Available at both top-level and per-field:**
```graphql
# Top-level (applies to all localized fields)
allBlogPosts(locale: it) { title }

# Per-field override
allBlogPosts(locale: it) {
  title                        # Italian
  enTitle: title(locale: en)   # English override
}
```

**`fallbackLocales`:** Ordered array. If value is null/empty for requested locale, tries next:
```graphql
allBlogPosts(locale: it_IT, fallbackLocales: [it, en]) { title }
```

**`_locales`:** Returns array of locale codes where record has content:
```graphql
allBlogPosts { _locales }  # -> ["en", "it"]
```

**`_all<Field>Locales`:** Returns all locale values:
```graphql
allBlogPosts { _allTitleLocales { locale value } }
```

**Filtering by locale:** `filter: { _locales: { anyIn: [it] } }`

**Non-localized fields** are unaffected by locale arguments.

## 3. StructuredText — Exact GraphQL Shape

```graphql
content {
  value          # JSON — raw DAST document
  blocks {       # Array — for `block` nodes
    ... on CtaBlockRecord { id __typename label url }
  }
  inlineBlocks { # Array — for `inlineBlock` nodes (SEPARATE from blocks!)
    ... on MentionBlockRecord { id __typename name }
  }
  links {        # Array — for `itemLink` and `inlineItem` nodes
    ... on BlogPostRecord { id __typename slug title }
  }
}
```

**Critical details:**
- `blocks`, `inlineBlocks`, `links` are **arrays**, not maps
- Each entry has `__typename` following `[ModelName]Record` convention
- `inlineBlocks` is a SEPARATE field from `blocks` (we currently merge them)
- All implement `RecordInterface` (provides `id`)
- DAST `item` field values match `id` values in the arrays

**Reference mapping:**
- `"type": "block"` → look up in `blocks`
- `"type": "inlineBlock"` → look up in `inlineBlocks`
- `"type": "itemLink"` → look up in `links`
- `"type": "inlineItem"` → look up in `links`

## 4. Filter Input Types by Field Type

**String:** `eq`, `neq`, `in`, `notIn`, `matches` (regex with `pattern` + `caseSensitive`), `notMatches`, `isBlank`, `isPresent`

**Integer/Float:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `exists`

**Boolean:** `eq` only

**DateTime:** `eq`, `neq`, `gt`, `lt`, `gte`, `lte`, `exists`

**Link (single):** `eq`, `neq`, `in`, `notIn`, `exists` — by record ID

**Links (multiple):** `eq` (exact array), `allIn`, `anyIn`, `notIn`, `exists`

**StructuredText:** `matches`, `notMatches` (regex on text content), `isBlank`, `isPresent`

**Logical:** `AND: [FilterInput!]`, `OR: [FilterInput!]` — arrays, nestable

**Meta filters:** `_createdAt`, `_updatedAt`, `_publishedAt`, `_firstPublishedAt` all support DateTime operators. `_status` supports `eq`, `neq`, `in`, `notIn`. `id` supports `eq`, `neq`, `in`, `notIn`.

## 5. Asset / responsiveImage

```graphql
coverImage {
  id url width height format size mimeType alt title
  blurhash thumbhash
  colors { hex }
  focalPoint { x y }  # 0.0-1.0

  responsiveImage(imgixParams: { fm: jpg, w: 600, h: 600 }) {
    src srcSet width height alt title
    base64    # data:image/jpeg;base64,... LQIP
    bgColor   # hex fallback color
    sizes     # sizes attribute value
  }
}
```

## 6. Naming Conventions

- **Single record:** `blogPost`, `homepage` (model apiKey verbatim)
- **Collection:** `allBlogPosts`, `allArtists` (all + PascalCase + plural)
- **Collection meta:** `_allBlogPostsMeta` (_ prefix + same + Meta)
- **Record types:** `BlogPostRecord`, `ArtistRecord` (PascalCase + Record suffix)
- **Record ID:** Numeric string (e.g., `"38945648"`) — NOT UUID

## 7. Gaps in Our Current Implementation

Based on this research, areas where we diverge from DatoCMS:

1. **`inlineBlocks` is separate from `blocks`** — we currently put both in `blocks`
2. **No `__typename` on block/link records** — DatoCMS uses `[ModelName]Record` convention
3. **No `X-Include-Drafts` header support** — we need to implement this in Yoga middleware
4. **No locale arguments on GraphQL queries** — need top-level + per-field `locale` and `fallbackLocales`
5. **Filter `matches` should be `{ pattern, caseSensitive }` object** — we currently use a plain string
6. **No `_locales` field** on records
7. **No `_all<Field>Locales` pattern**
8. **Collection naming:** we use `allPosts` not `allPostRecords` — verify naming convention
9. **IDs:** we use ULID, DatoCMS uses numeric strings — this is fine, just different
10. **responsiveImage:** we don't have this yet (needs Cloudflare Images integration)
