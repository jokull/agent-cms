import { graphql } from "gql.tada";

export const SITE_SETTINGS_QUERY = graphql(`
  query SiteSettings {
    siteSettings {
      siteName
      tagline
      logo {
        url
        responsiveImage(transforms: { width: 200 }) {
          src
          srcSet
          width
          height
          alt
        }
      }
      defaultSeo {
        title
        description
      }
    }
  }
`);

export const ALL_POSTS_QUERY = graphql(`
  query AllPosts($first: Int, $skip: Int) {
    allPosts(first: $first, skip: $skip, orderBy: [publishedDate_DESC]) {
      id
      title
      slug
      excerpt
      publishedDate
      readingTime
      featured
      coverImage {
        responsiveImage(transforms: { width: 800, height: 450, fit: "cover" }) {
          src
          srcSet
          webpSrcSet
          width
          height
          aspectRatio
          alt
        }
      }
      category {
        name
        slug
      }
      author {
        name
      }
      _seoMetaTags {
        tag
        attributes
        content
      }
    }
    _allPostsMeta {
      count
    }
  }
`);

export const POST_BY_SLUG_QUERY = graphql(`
  query PostBySlug($slug: String!) {
    post(filter: { slug: { eq: $slug } }) {
      id
      title
      slug
      excerpt
      publishedDate
      readingTime
      featured
      coverImage {
        responsiveImage(transforms: { width: 1200, height: 630, fit: "cover" }) {
          src
          srcSet
          webpSrcSet
          width
          height
          aspectRatio
          alt
        }
      }
      content {
        value
        blocks
        inlineBlocks
        links
      }
      author {
        name
        bio
        photo {
          responsiveImage(transforms: { width: 64, height: 64, fit: "cover" }) {
            src
            srcSet
            width
            height
            alt
          }
        }
      }
      category {
        name
        slug
      }
      relatedPosts {
        title
        slug
        coverImage {
          responsiveImage(transforms: { width: 400, height: 225, fit: "cover" }) {
            src
            srcSet
            width
            height
            alt
          }
        }
      }
      gallery {
        responsiveImage(transforms: { width: 600 }) {
          src
          srcSet
          webpSrcSet
          width
          height
          aspectRatio
          alt
        }
      }
      seoField {
        title
        description
      }
      _seoMetaTags {
        tag
        attributes
        content
      }
    }
  }
`);

export const POSTS_BY_CATEGORY_QUERY = graphql(`
  query PostsByCategory($categorySlug: String!) {
    allPosts(filter: { category: { eq: $categorySlug } }, orderBy: [publishedDate_DESC]) {
      id
      title
      slug
      excerpt
      publishedDate
      readingTime
      coverImage {
        responsiveImage(transforms: { width: 600, height: 340, fit: "cover" }) {
          src
          srcSet
          webpSrcSet
          width
          height
          alt
        }
      }
      author {
        name
      }
    }
  }
`);

export const CATEGORY_BY_SLUG_QUERY = graphql(`
  query CategoryBySlug($slug: String!) {
    category(filter: { slug: { eq: $slug } }) {
      name
      slug
      description
      coverImage {
        responsiveImage(transforms: { width: 1200, height: 400, fit: "cover" }) {
          src
          srcSet
          width
          height
          alt
        }
      }
    }
  }
`);

export const ALL_CATEGORIES_QUERY = graphql(`
  query AllCategories {
    allCategorys(orderBy: [sortOrder_ASC]) {
      name
      slug
      description
      icon
      sortOrder
    }
  }
`);
