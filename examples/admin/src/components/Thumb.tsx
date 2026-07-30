/**
 * The one place this app turns an asset into pixels.
 *
 * Every read now carries a canonical `url` (asset rows, media / media_gallery
 * values, picker rows), and `assetUrl` from `@agent-cms/codegen/assets`
 * composes a Cloudflare Image Resizing URL on top of it. Nothing here knows
 * the asset origin, the bucket, or the r2_key — that was FRICTION.md #3.
 */
import { assetUrl } from "@agent-cms/codegen/assets";

export interface ThumbProps {
  readonly src: string | null | undefined;
  readonly alt?: string | null;
  readonly size?: number;
  readonly className?: string;
}

export function Thumb({ src, alt, size = 40, className }: ThumbProps) {
  if (!src) return <span className={`thumb thumb--empty ${className ?? ""}`}>—</span>;
  return (
    <img
      className={`thumb ${className ?? ""}`}
      src={assetUrl(src, { width: size * 2, height: size * 2, fit: "cover", format: "auto" })}
      alt={alt ?? ""}
      width={size}
      height={size}
      loading="lazy"
    />
  );
}

/** Larger, aspect-preserving preview (media grid tiles, field previews). */
export function Preview({
  src,
  alt,
  width = 320,
  className,
}: {
  readonly src: string | null | undefined;
  readonly alt?: string | null;
  readonly width?: number;
  readonly className?: string;
}) {
  if (!src) return <span className={`tile__ph ${className ?? ""}`}>no file</span>;
  return (
    <img
      className={`preview ${className ?? ""}`}
      src={assetUrl(src, { width, fit: "scale-down", format: "auto" })}
      alt={alt ?? ""}
      loading="lazy"
    />
  );
}
