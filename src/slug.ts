import slugify from "slugify";

/**
 * Generate a URL-safe slug from a string.
 * Django-parity: NFKD decomposition + charmap for non-decomposable chars.
 */
export function generateSlug(input: string): string {
  return slugify(input, {
    lower: true,
    strict: true, // strip special characters
    locale: "en",
  });
}
