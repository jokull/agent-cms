-- Site-level settings for _site GraphQL query (globalSeo, faviconMetaTags, noIndex)
CREATE TABLE IF NOT EXISTS `site_settings` (
	`id` text PRIMARY KEY DEFAULT 'default',
	`site_name` text,
	`title_suffix` text,
	`no_index` integer DEFAULT 0 NOT NULL,
	`favicon_id` text,
	`facebook_page_url` text,
	`twitter_account` text,
	`fallback_seo_title` text,
	`fallback_seo_description` text,
	`fallback_seo_image_id` text,
	`fallback_seo_twitter_card` text DEFAULT 'summary',
	`updated_at` text NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT `fk_site_settings_favicon` FOREIGN KEY (`favicon_id`) REFERENCES `assets`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_site_settings_seo_image` FOREIGN KEY (`fallback_seo_image_id`) REFERENCES `assets`(`id`) ON DELETE SET NULL
);

-- Asset custom metadata (JSON key-value pairs, DatoCMS compat)
ALTER TABLE `assets` ADD COLUMN `custom_data` text DEFAULT '{}';
