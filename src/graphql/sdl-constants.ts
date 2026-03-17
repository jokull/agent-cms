/**
 * Static SDL (Schema Definition Language) strings for the GraphQL schema.
 */

/** Base type definitions: scalars, assets, responsive image, SEO, color, lat_lon, etc. */
export const BASE_TYPE_DEFS = `scalar JSON

"""Cloudflare Image Resizing transform parameters"""
input ImageTransformParams {
  width: Int
  height: Int
  fit: String
  quality: Int
  format: String
  gravity: String
  dpr: Int
  zoom: Float
  background: String
  blur: Int
  sharpen: Float
  rotate: Int
  anim: Boolean
  trim: ImageTrimParams
}
input ImageTrimParams {
  top: Int
  right: Int
  bottom: Int
  left: Int
  width: Int
  height: Int
}
type Asset {
  id: ID!
  filename: String!
  mimeType: String!
  size: Int!
  width: Int
  height: Int
  alt: String
  title: String
  url: String!
  blurhash: String
  customData: JSON
  responsiveImage(transforms: ImageTransformParams, cfImagesParams: ImageTransformParams, imgixParams: ImageTransformParams): ResponsiveImage
}
type ResponsiveImage {
  src: String!
  srcSet: String!
  webpSrcSet: String!
  width: Int!
  height: Int!
  aspectRatio: Float!
  alt: String
  title: String
  base64: String
  bgColor: String
  sizes: String
}
type SiteInfo {
  locales: [String!]!
  faviconMetaTags: [Tag!]!
  globalSeo(locale: String, fallbackLocales: [String!]): GlobalSeoField
  noIndex: Boolean!
}
type GlobalSeoField {
  siteName: String
  titleSuffix: String
  fallbackSeo: SeoField
  facebookPageUrl: String
  twitterAccount: String
}
"""DatoCMS-compatible SEO meta tag"""
type Tag {
  tag: String!
  attributes: JSON
  content: String
}
type SeoField {
  title: String
  description: String
  image: Asset
  twitterCard: String
}
type ColorField {
  red: Int!
  green: Int!
  blue: Int!
  alpha: Int
  hex: String!
}
type LatLonField {
  latitude: Float!
  longitude: Float!
}

"""DatoCMS-compatible StructuredText response"""
type StructuredText {
  value: JSON!
  blocks: [JSON!]!
  inlineBlocks: [JSON!]!
  links: [JSON!]!
}
type StringMultiLocaleField { locale: String!, value: String }
type IntMultiLocaleField { locale: String!, value: Int }
type FloatMultiLocaleField { locale: String!, value: Float }
type BooleanMultiLocaleField { locale: String!, value: Boolean }
type JsonMultiLocaleField { locale: String!, value: JSON }
type SeoMultiLocaleField { locale: String!, value: SeoField }
input MatchesFilter { pattern: String!, caseSensitive: Boolean }
input StringFilter { eq: String, neq: String, in: [String!], notIn: [String!], matches: String, notMatches: String, isBlank: Boolean, isPresent: Boolean, exists: Boolean }
input TextFilter { matches: String, notMatches: String, isBlank: Boolean, isPresent: Boolean, exists: Boolean }
input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
input FloatFilter { eq: Float, neq: Float, gt: Float, lt: Float, gte: Float, lte: Float, exists: Boolean }
input BooleanFilter { eq: Boolean, exists: Boolean }
input DateTimeFilter { eq: String, neq: String, gt: String, lt: String, gte: String, lte: String, exists: Boolean }
"""Filter for single-reference fields (link, media) by record/asset ID"""
input LinkFilter { eq: ID, neq: ID, in: [ID!], notIn: [ID!], exists: Boolean }
"""Filter for multi-reference fields (links, media_gallery) stored as JSON arrays"""
input LinksFilter { eq: [ID!], allIn: [ID!], anyIn: [ID!], notIn: [ID!], exists: Boolean }
"""Filter for geolocation fields"""
input NearFilter { latitude: Float!, longitude: Float!, radius: Float! }
input LatLonFilter { near: NearFilter, exists: Boolean }
"""Filter for fields that only support existence checks (seo, json, color)"""
input ExistsFilter { exists: Boolean }
"""Filter records by which locales have content"""
input LocalesFilter { allIn: [String!], anyIn: [String!], notIn: [String!] }
"""Filter for tree model parent field"""
input ParentFilter { eq: ID, exists: Boolean }
input PositionFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int }`;

/** Upload-related type definitions */
export const UPLOAD_TYPE_DEFS = `input UploadFilter {
  id: StringFilter
  filename: StringFilter
  mimeType: StringFilter
  width: IntFilter
  height: IntFilter
  size: IntFilter
  alt: StringFilter
  title: StringFilter
  _createdAt: DateTimeFilter
  AND: [UploadFilter!]
  OR: [UploadFilter!]
}
enum UploadOrderBy {
  filename_ASC filename_DESC
  size_ASC size_DESC
  _createdAt_ASC _createdAt_DESC
}
type UploadMeta { count: Int! }`;
