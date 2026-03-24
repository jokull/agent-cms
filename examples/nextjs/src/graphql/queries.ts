import { graphql } from "gql.tada";

export const POST_PAGE_QUERY = graphql(`
  query PostPage($slug: String!) {
    post(filter: { slug: { eq: $slug } }) {
      id
      title
      slug
      excerpt
      publishedDate
      _status
      author {
        name
      }
      category {
        name
        slug
      }
      content {
        value
      }
    }
    _site {
      globalSeo {
        siteName
      }
    }
  }
`);
