CREATE TABLE `assets` (
	`id` text PRIMARY KEY,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`alt` text,
	`title` text,
	`r2_key` text NOT NULL,
	`blurhash` text,
	`colors` text,
	`focal_point` text,
	`tags` text DEFAULT '[]',
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY,
	`model_id` text NOT NULL,
	`label` text NOT NULL,
	`api_key` text NOT NULL,
	`field_type` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`localized` integer DEFAULT false NOT NULL,
	`validators` text DEFAULT '{}',
	`default_value` text,
	`appearance` text,
	`hint` text,
	`fieldset_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_fields_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_fields_fieldset_id_fieldsets_id_fk` FOREIGN KEY (`fieldset_id`) REFERENCES `fieldsets`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `fieldsets` (
	`id` text PRIMARY KEY,
	`model_id` text NOT NULL,
	`title` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_fieldsets_model_id_models_id_fk` FOREIGN KEY (`model_id`) REFERENCES `models`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `locales` (
	`id` text PRIMARY KEY,
	`code` text NOT NULL UNIQUE,
	`position` integer DEFAULT 0 NOT NULL,
	`fallback_locale_id` text,
	CONSTRAINT `fk_locales_fallback_locale_id_locales_id_fk` FOREIGN KEY (`fallback_locale_id`) REFERENCES `locales`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `models` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`api_key` text NOT NULL UNIQUE,
	`is_block` integer DEFAULT false NOT NULL,
	`singleton` integer DEFAULT false NOT NULL,
	`sortable` integer DEFAULT false NOT NULL,
	`tree` integer DEFAULT false NOT NULL,
	`has_draft` integer DEFAULT true NOT NULL,
	`ordering` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
