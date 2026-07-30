-- DatoCMS parity: presentation hints for record links / block cards.
-- Nullable — reference a field api_key on the same model, validated at the
-- service layer (not enforceable via FK since fields are keyed by api_key, not id).
ALTER TABLE "models" ADD COLUMN "title_field" text;
ALTER TABLE "models" ADD COLUMN "image_preview_field" text;
