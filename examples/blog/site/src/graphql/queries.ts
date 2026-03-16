import { graphql } from "gql.tada";

export const SITE_SETTINGS_QUERY = graphql(`
  query SiteSettings {
    site_settings {
      site_name
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
      default_seo {
        title
        description
      }
    }
  }
`);

export const ALL_POSTS_QUERY = graphql(`
  query AllPosts($first: Int, $skip: Int) {
    allPosts(first: $first, skip: $skip, orderBy: [published_date_DESC]) {
      id
      title
      slug
      excerpt
      published_date
      reading_time
      featured
      cover_image {
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
      published_date
      reading_time
      featured
      cover_image {
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
      related_posts {
        title
        slug
        cover_image {
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
      seo_field {
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
    allPosts(filter: { category: { eq: $categorySlug } }, orderBy: [published_date_DESC]) {
      id
      title
      slug
      excerpt
      published_date
      reading_time
      cover_image {
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
      cover_image {
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
    allCategorys(orderBy: [sort_order_ASC]) {
      name
      slug
      description
      icon
      sort_order
    }
  }
`);
