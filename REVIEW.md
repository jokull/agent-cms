# Code Review (codex, gpt-5.4)

Run: 2026-03-16

## Finding (P2, fixed)

**Preserve locale resolution for localized slug/date fields** — `src/graphql/schema-builder.ts:433-434`

The field type registry refactor set `localizable: false` for `slug`, `date`, and `date_time` field types. But the old code included these types in locale resolution (the exclusion list only blocked `link`, `links`, `media`, etc.). This meant that if a model had a `localized: true` field of type `slug`, `date`, or `date_time`, the locale resolver would be skipped and the raw JSON locale map would be returned instead of the resolved value.

**Fix:** Set `localizable: true` for `slug`, `date`, `date_time` in the registry.

## Overall Assessment

The field type registry refactor improves consistency and centralizes field type definitions. With the localizability fix applied, the refactor is behavior-preserving.
