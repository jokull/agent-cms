import { graphql } from "gql.tada";

export const PAGE_QUERY = graphql(`
  query Page($locale: SiteLocale!) {
    page(locale: $locale) {
      title
      body
      _allTitleLocales {
        locale
        value
      }
    }
  }
`);
