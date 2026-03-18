export const PAGE_QUERY = `
  query Page($locale: SiteLocale, $fallbackLocales: [SiteLocale!]) {
    page(locale: $locale, fallbackLocales: $fallbackLocales) {
      id
      _status
      title
      heroImage {
        id
        url
        width
        height
        alt
      }
      body {
        value
        blocks {
          __typename
          ... on ImageBlockRecord {
            id
            image {
              id
              url
              width
              height
              alt
            }
            caption
          }
        }
      }
    }
  }
`;

export interface PageData {
  page: {
    id: string;
    _status: "draft" | "published" | "updated";
    title: string;
    heroImage: {
      id: string;
      url: string;
      width: number;
      height: number;
      alt: string | null;
    } | null;
    body: {
      value: DastDocument;
      blocks: BodyBlock[];
    } | null;
  } | null;
}

export type BodyBlock = ImageBlockRecord;

export interface ImageBlockRecord {
  __typename: "ImageBlockRecord";
  id: string;
  image: {
    id: string;
    url: string;
    width: number;
    height: number;
    alt: string | null;
  };
  caption: string | null;
}

interface DastDocument {
  schema: "dast";
  document: {
    type: "root";
    children: DastNode[];
  };
}

type DastNode =
  | { type: "paragraph"; children: DastInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: DastInline[] }
  | { type: "list"; style: "bulleted" | "numbered"; children: DastListItem[] }
  | { type: "blockquote"; children: { type: "paragraph"; children: DastInline[] }[] }
  | { type: "code"; code: string; language?: string }
  | { type: "thematicBreak" }
  | { type: "block"; item: string };

type DastListItem = { type: "listItem"; children: DastNode[] };

type DastInline =
  | { type: "span"; value: string; marks?: string[] }
  | { type: "link"; url: string; children: { type: "span"; value: string; marks?: string[] }[] };
