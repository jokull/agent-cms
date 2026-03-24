import { graphql } from "gql.tada";

export const ResponsiveImageFragment = graphql(`
  fragment ResponsiveImageFields on Asset @_unmask {
    url
    alt
    width
    height
    responsiveImage(imgixParams: { w: 800 }) {
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

export const SeoFragment = graphql(`
  fragment SeoFields on SeoField @_unmask {
    title
    description
  }
`);
