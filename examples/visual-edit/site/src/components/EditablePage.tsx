import { CmsEditProvider, CmsRecord, CmsField, CmsImage, CmsText } from "@agent-cms/visual-edit-react";
import type { RecordStatus } from "@agent-cms/visual-edit-react";
import type { PageData, BodyBlock, ImageBlockRecord } from "../graphql/queries";

interface Props {
  page: NonNullable<PageData["page"]>;
  locale: string;
  editMode: boolean;
  cmsEndpoint: string;
  writeKey: string;
}

export default function EditablePage({ page, locale, editMode, cmsEndpoint, writeKey }: Props) {
  const reload = () => window.location.reload();

  // Asset URLs from GraphQL are relative — prefix with CMS endpoint
  const assetUrl = (path: string) =>
    path.startsWith("http") ? path : `${cmsEndpoint}${path}`;

  // Index blocks by ID for lookup during DAST rendering
  const blockMap = new Map<string, BodyBlock>();
  for (const block of page.body?.blocks ?? []) {
    blockMap.set(block.id, block);
  }

  const content = (
    <CmsRecord
      recordId={page.id}
      modelApiKey="page"
      locale={locale}
      status={page._status as RecordStatus}
      onPublished={reload}
    >
      <CmsField fieldApiKey="title" value={page.title} onSaved={reload}>
        <h1 style={{ fontSize: "2.5rem", fontWeight: 700, marginBottom: "1.5rem" }}>
          {page.title}
        </h1>
      </CmsField>

      {page.heroImage && (
        <CmsImage assetId={page.heroImage.id} onReplaced={reload}>
          <img
            src={assetUrl(page.heroImage.url)}
            alt={page.heroImage.alt ?? ""}
            width={page.heroImage.width}
            height={page.heroImage.height}
            style={{
              width: "100%",
              height: "auto",
              borderRadius: 8,
              marginBottom: "2rem",
            }}
          />
        </CmsImage>
      )}

      {page.body?.value && (
        <CmsText fieldApiKey="body" value={page.body.value} onSaved={reload}>
          <div style={{ fontSize: "1.1rem" }}>
            <RenderDast
              document={page.body.value.document}
              blockMap={blockMap}
              assetUrl={assetUrl}
              onBlockImageReplaced={reload}
            />
          </div>
        </CmsText>
      )}
    </CmsRecord>
  );

  if (!editMode) return content;

  return (
    <CmsEditProvider endpoint={cmsEndpoint} writeKey={writeKey}>
      {content}
    </CmsEditProvider>
  );
}

// ---------------------------------------------------------------------------
// DAST renderer with block support
// ---------------------------------------------------------------------------

interface RenderDastProps {
  document: { type: "root"; children: DastNode[] };
  blockMap: Map<string, BodyBlock>;
  assetUrl: (path: string) => string;
  onBlockImageReplaced?: () => void;
}

function RenderDast({ document, blockMap, assetUrl, onBlockImageReplaced }: RenderDastProps) {
  return (
    <>
      {document.children.map((node, i) => (
        <RenderBlock
          key={i}
          node={node}
          blockMap={blockMap}
          assetUrl={assetUrl}
          onBlockImageReplaced={onBlockImageReplaced}
        />
      ))}
    </>
  );
}

type DastNode = {
  type: string;
  children?: unknown[];
  level?: number;
  style?: string;
  code?: string;
  language?: string;
  item?: string;
  [key: string]: unknown;
};

interface RenderBlockProps {
  node: DastNode;
  blockMap: Map<string, BodyBlock>;
  assetUrl: (path: string) => string;
  onBlockImageReplaced?: () => void;
}

function RenderBlock({ node, blockMap, assetUrl, onBlockImageReplaced }: RenderBlockProps) {
  switch (node.type) {
    case "paragraph":
      return <p style={{ marginBottom: "1rem" }}>{renderInlines(node.children ?? [])}</p>;
    case "heading": {
      const Tag = `h${node.level ?? 2}` as keyof JSX.IntrinsicElements;
      return <Tag style={{ marginTop: "1.5rem", marginBottom: "0.75rem" }}>{renderInlines(node.children ?? [])}</Tag>;
    }
    case "list": {
      const Tag = node.style === "numbered" ? "ol" : "ul";
      return (
        <Tag style={{ marginBottom: "1rem", paddingLeft: "1.5rem" }}>
          {(node.children as DastNode[] ?? []).map((item, i) => (
            <li key={i}>
              {(item.children as DastNode[] ?? []).map((child, j) => (
                <RenderBlock
                  key={j}
                  node={child}
                  blockMap={blockMap}
                  assetUrl={assetUrl}
                  onBlockImageReplaced={onBlockImageReplaced}
                />
              ))}
            </li>
          ))}
        </Tag>
      );
    }
    case "blockquote":
      return (
        <blockquote style={{ borderLeft: "3px solid #d1d5db", paddingLeft: "1rem", margin: "1rem 0", color: "#6b7280" }}>
          {(node.children as DastNode[] ?? []).map((child, i) => (
            <RenderBlock
              key={i}
              node={child}
              blockMap={blockMap}
              assetUrl={assetUrl}
              onBlockImageReplaced={onBlockImageReplaced}
            />
          ))}
        </blockquote>
      );
    case "code":
      return (
        <pre style={{ background: "#f3f4f6", padding: "1rem", borderRadius: 6, overflowX: "auto", marginBottom: "1rem" }}>
          <code>{node.code}</code>
        </pre>
      );
    case "thematicBreak":
      return <hr style={{ margin: "2rem 0", border: "none", borderTop: "1px solid #e5e7eb" }} />;
    case "block": {
      const block = node.item ? blockMap.get(node.item) : undefined;
      if (!block) return null;
      return <RenderBlockNode block={block} assetUrl={assetUrl} onImageReplaced={onBlockImageReplaced} />;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Block dispatch
// ---------------------------------------------------------------------------

function RenderBlockNode({
  block,
  assetUrl,
  onImageReplaced,
}: {
  block: BodyBlock;
  assetUrl: (path: string) => string;
  onImageReplaced?: () => void;
}) {
  switch (block.__typename) {
    case "ImageBlockRecord":
      return <ImageBlock block={block} assetUrl={assetUrl} onImageReplaced={onImageReplaced} />;
    default:
      return null;
  }
}

function ImageBlock({
  block,
  assetUrl,
  onImageReplaced,
}: {
  block: ImageBlockRecord;
  assetUrl: (path: string) => string;
  onImageReplaced?: () => void;
}) {
  return (
    <figure style={{ margin: "2rem 0" }}>
      <CmsImage assetId={block.image.id} onReplaced={onImageReplaced}>
        <img
          src={assetUrl(block.image.url)}
          alt={block.image.alt ?? block.caption ?? ""}
          width={block.image.width}
          height={block.image.height}
          style={{
            width: "100%",
            height: "auto",
            borderRadius: 8,
          }}
        />
      </CmsImage>
      {block.caption && (
        <figcaption
          style={{
            marginTop: "0.5rem",
            fontSize: "0.9rem",
            color: "#6b7280",
            textAlign: "center",
          }}
        >
          {block.caption}
        </figcaption>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

type DastInline = {
  type: string;
  value?: string;
  marks?: string[];
  url?: string;
  children?: DastInline[];
};

function renderInlines(children: unknown[]): React.ReactNode[] {
  return (children as DastInline[]).map((inline, i) => {
    if (inline.type === "span") {
      let content: React.ReactNode = inline.value ?? "";
      const marks = inline.marks ?? [];
      if (marks.includes("code")) return <code key={i} style={{ background: "#f3f4f6", padding: "2px 6px", borderRadius: 3, fontSize: "0.9em" }}>{inline.value}</code>;
      if (marks.includes("strong")) content = <strong key={`s${i}`}>{content}</strong>;
      if (marks.includes("emphasis")) content = <em key={`e${i}`}>{content}</em>;
      if (marks.includes("strikethrough")) content = <s key={`d${i}`}>{content}</s>;
      if (marks.includes("underline")) content = <u key={`u${i}`}>{content}</u>;
      if (marks.includes("highlight")) content = <mark key={`m${i}`}>{content}</mark>;
      return <span key={i}>{content}</span>;
    }
    if (inline.type === "link") {
      return (
        <a key={i} href={inline.url} style={{ color: "#3b82f6" }}>
          {renderInlines(inline.children ?? [])}
        </a>
      );
    }
    return null;
  });
}
