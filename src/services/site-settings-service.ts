import { Effect } from "effect";
import { SqlClient } from "@effect/sql";
import { SchemaEngineError, ValidationError } from "../errors.js";

type SiteSettingsInput = {
  siteName?: string;
  titleSuffix?: string;
  noIndex?: boolean;
  faviconId?: string;
  facebookPageUrl?: string;
  twitterAccount?: string;
  fallbackSeoTitle?: string;
  fallbackSeoDescription?: string;
  fallbackSeoImageId?: string;
  fallbackSeoTwitterCard?: string;
};

const fieldMap: Record<keyof SiteSettingsInput, string> = {
  siteName: "site_name",
  titleSuffix: "title_suffix",
  noIndex: "no_index",
  faviconId: "favicon_id",
  facebookPageUrl: "facebook_page_url",
  twitterAccount: "twitter_account",
  fallbackSeoTitle: "fallback_seo_title",
  fallbackSeoDescription: "fallback_seo_description",
  fallbackSeoImageId: "fallback_seo_image_id",
  fallbackSeoTwitterCard: "fallback_seo_twitter_card",
};

function mapMissingTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("no such table: site_settings")) {
    return new SchemaEngineError({
      message: "site_settings table not found. Run setup/migrations before using site settings.",
      cause: error,
    });
  }
  return new SchemaEngineError({
    message: "Failed to access site settings",
    cause: error,
  });
}

export function getSiteSettings() {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM site_settings LIMIT 1");
    return rows.length > 0
      ? rows[0]
      : { message: "No site settings configured yet. Use update_site_settings to create them." };
  }).pipe(Effect.mapError(mapMissingTable));
}

export function updateSiteSettings(args: SiteSettingsInput) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sets: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(args)) {
      const col = fieldMap[key as keyof SiteSettingsInput];
      if (col && value !== undefined) {
        sets.push(`"${col}" = ?`);
        params.push(typeof value === "boolean" ? (value ? 1 : 0) : value);
      }
    }

    if (sets.length === 0) {
      return yield* new ValidationError({ message: "No fields to update" });
    }

    sets.push(`"updated_at" = datetime('now')`);
    yield* sql.unsafe(`INSERT OR IGNORE INTO site_settings (id) VALUES ('default')`);
    yield* sql.unsafe(`UPDATE site_settings SET ${sets.join(", ")} WHERE id = 'default'`, params);
    const rows = yield* sql.unsafe<Record<string, unknown>>("SELECT * FROM site_settings WHERE id = 'default'");
    return rows[0];
  }).pipe(Effect.mapError((error) => {
    if (error instanceof ValidationError) return error;
    return mapMissingTable(error);
  }));
}
