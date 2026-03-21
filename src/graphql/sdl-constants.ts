/**
 * Static SDL (Schema Definition Language) strings for the GraphQL schema.
 */

/** Base type definitions: scalars, assets, responsive image, SEO, color, lat_lon, etc. */
export const BASE_TYPE_DEFS = `scalar JSON
scalar ItemId

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
"""
Legacy DatoCMS/imgix compatibility shim.
Accepted only to smooth migrations; values are translated best-effort to
Cloudflare image transforms and do not imply full imgix parity.
"""
input ImgixParamsShim {
  w: Float
  h: Float
  fit: ImgixFitShim
  auto: [ImgixAutoValueShim!]
  q: Int
  dpr: Float
  blur: Int
  bg: String
  rot: Float
  facepad: Float
  maxW: Int
  maxH: Int
}
enum ImgixFitShim {
  crop
  clip
  fill
  facearea
  scale
  max
}
enum ImgixAutoValueShim {
  format
  compress
}
type Asset {
  id: ID!
  filename: String!
  basename: String!
  format: String!
  mimeType: String!
  size: Int!
  width: Int
  height: Int
  alt: String
  title: String
  url(transforms: ImageTransformParams, cfImagesParams: ImageTransformParams, imgixParams: ImgixParamsShim): String!
  blurhash: String
  focalPoint: FocalPoint
  customData: JSON
  tags: [String!]!
  smartTags: [String!]!
  _createdAt: String!
  _updatedAt: String!
  _createdBy: String
  _updatedBy: String
  responsiveImage(transforms: ImageTransformParams, cfImagesParams: ImageTransformParams, imgixParams: ImgixParamsShim): ResponsiveImage
}
type FocalPoint {
  x: Float!
  y: Float!
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
  locales: [SiteLocale!]!
  faviconMetaTags: [Tag!]!
  globalSeo(locale: SiteLocale, fallbackLocales: [SiteLocale!]): GlobalSeoField
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
type VideoField {
  url: String
  title: String
  provider: String
  providerUid: String
  thumbnailUrl: String
  width: Int
  height: Int
}

"""DatoCMS-compatible StructuredText response"""
type StructuredText {
  value: JSON!
  blocks: [JSON!]!
  inlineBlocks: [JSON!]!
  links: [JSON!]!
}
type StringMultiLocaleField { locale: SiteLocale!, value: String }
type IntMultiLocaleField { locale: SiteLocale!, value: Int }
type FloatMultiLocaleField { locale: SiteLocale!, value: Float }
type BooleanMultiLocaleField { locale: SiteLocale!, value: Boolean }
type JsonMultiLocaleField { locale: SiteLocale!, value: JSON }
type SeoMultiLocaleField { locale: SiteLocale!, value: SeoField }
enum ItemStatus { draft published updated }
input MatchesFilter { pattern: String!, caseSensitive: Boolean }
input StringFilter { eq: String, neq: String, in: [String!], notIn: [String!], matches: String, notMatches: String, isBlank: Boolean, isPresent: Boolean, exists: Boolean }
input TextFilter { matches: String, notMatches: String, isBlank: Boolean, isPresent: Boolean, exists: Boolean }
input IntFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int, exists: Boolean }
input FloatFilter { eq: Float, neq: Float, gt: Float, lt: Float, gte: Float, lte: Float, exists: Boolean }
input BooleanFilter { eq: Boolean, exists: Boolean }
input StatusFilter { eq: ItemStatus, neq: ItemStatus, in: [ItemStatus!], notIn: [ItemStatus!], exists: Boolean }
input DateTimeFilter { eq: String, neq: String, gt: String, lt: String, gte: String, lte: String, exists: Boolean }
"""Filter for single-reference fields (link, media) by record/asset ID"""
input LinkFilter { eq: ItemId, neq: ItemId, in: [ItemId!], notIn: [ItemId!], exists: Boolean }
"""Filter for multi-reference fields (links, media_gallery) stored as JSON arrays"""
input LinksFilter { eq: [ItemId!], allIn: [ItemId!], anyIn: [ItemId!], notIn: [ItemId!], exists: Boolean }
"""Filter for geolocation fields"""
input NearFilter { latitude: Float!, longitude: Float!, radius: Float! }
input LatLonFilter { near: NearFilter, exists: Boolean }
"""Filter for fields that only support existence checks (seo, json, color)"""
input ExistsFilter { exists: Boolean }
"""Filter records by which locales have content"""
input LocalesFilter { allIn: [SiteLocale!], anyIn: [SiteLocale!], notIn: [SiteLocale!] }
"""Filter for tree model parent field"""
input ParentFilter { eq: ItemId, exists: Boolean }
input PositionFilter { eq: Int, neq: Int, gt: Int, lt: Int, gte: Int, lte: Int }`;

/** Upload-related type definitions */
export const UPLOAD_TYPE_DEFS = `input UploadFilter {
  id: StringFilter
  filename: StringFilter
  basename: StringFilter
  format: StringFilter
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
  basename_ASC basename_DESC
  format_ASC format_DESC
  size_ASC size_DESC
  _createdAt_ASC _createdAt_DESC
}
type UploadMeta { count: Int! }`;
