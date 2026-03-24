import { graphql } from "gql.tada";

export const ResponsiveImageFragment = graphql(`
  fragment ResponsiveImageFields on Asset @_unmask {
    url
    alt
    width
    height
    responsiveImage {
      src
      srcSet
      webpSrcSet
      width
      height
      aspectRatio
      sizes
    }
  }
`);
