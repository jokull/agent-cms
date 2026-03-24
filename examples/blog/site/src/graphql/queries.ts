import { graphql } from "gql.tada";
import { SeoFragment } from "./fragments";

export const SITE_SETTINGS_QUERY = graphql(`
  query SiteSettings {
    siteSettings {
      siteName
      tagline
      defaultSeo {
        ...SeoFields
      }
    }
  }
`, [SeoFragment]);

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
      content {
        value
        blocks {
          __typename
          ... on HeroSectionRecord {
            id
            headline
            subheadline
          }
          ... on CodeBlockRecord {
            id
            code
            language
            filename
          }
        }
        inlineBlocks {
          __typename
          ... on HeroSectionRecord {
            id
            headline
            subheadline
          }
          ... on CodeBlockRecord {
            id
            code
            language
            filename
          }
        }
        links
      }
      author {
        name
        bio
      }
      category {
        name
        slug
      }
      seoField {
        ...SeoFields
      }
      _seoMetaTags {
        tag
        attributes
        content
      }
    }
  }
`, [SeoFragment]);

export const POSTS_BY_CATEGORY_QUERY = graphql(`
  query PostsByCategory($categoryId: ID!) {
    allPosts(filter: { category: { eq: $categoryId } }, orderBy: [publishedDate_DESC]) {
      id
      title
      slug
      excerpt
      publishedDate
      readingTime
      author {
        name
      }
    }
  }
`);

export const CATEGORY_BY_SLUG_QUERY = graphql(`
  query CategoryBySlug($slug: String!) {
    category(filter: { slug: { eq: $slug } }) {
      id
      name
      slug
      description
    }
  }
`);

export const ALL_CATEGORIES_QUERY = graphql(`
  query AllCategories {
    allCategories(orderBy: [sortOrder_ASC]) {
      name
      slug
      description
      icon
      sortOrder
    }
  }
`);
