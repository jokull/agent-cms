import { draftMode, cookies } from "next/headers";
import { notFound } from "next/navigation";
import { cmsQuery } from "../../../lib/cms";
import { POST_PAGE_QUERY } from "../../../graphql/queries";
import { PreviewBar } from "../../../components/preview-bar";

/**
 * Single post page with draft preview support.
 *
 * Uses a multi-root GraphQL query to fetch the post and site settings
 * in a single request. Types are inferred from the schema via gql.tada.
 */

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const draft = await draftMode();
  const previewToken = draft.isEnabled
    ? (await cookies()).get("__agentcms_preview")?.value
    : undefined;

  const data = await cmsQuery(
    POST_PAGE_QUERY,
    { slug },
    { previewToken },
  );

  if (!data.post) notFound();

  const post = data.post;
  const siteName = data._site?.globalSeo?.siteName;

  return (
    <>
      <article style={{ maxWidth: 720, margin: "0 auto", padding: "2rem" }}>
        <header>
          {post.category && (
            <a
              href={`/categories/${post.category.slug}`}
              style={{
                fontSize: "0.8rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 600,
              }}
            >
              {post.category.name}
            </a>
          )}
          <h1 style={{ fontSize: "2.5rem", lineHeight: 1.2, margin: "0.5rem 0 1rem" }}>
            {post.title}
          </h1>
          {post._status === "draft" && (
            <span
              style={{
                background: "#fef3c7",
                color: "#92400e",
                padding: "0.15rem 0.5rem",
                borderRadius: 4,
                fontSize: "0.75rem",
                fontWeight: 600,
              }}
            >
              Draft
            </span>
          )}
          <div style={{ display: "flex", gap: "1.5rem", fontSize: "0.9rem", color: "#666", marginTop: "0.5rem" }}>
            {post.author && <span>{post.author.name}</span>}
            {post.publishedDate && (
              <time dateTime={post.publishedDate}>
                {new Date(post.publishedDate).toLocaleDateString("en", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })}
              </time>
            )}
          </div>
        </header>

        {post.excerpt && (
          <p style={{ fontSize: "1.1rem", color: "#555", margin: "1.5rem 0" }}>
            {post.excerpt}
          </p>
        )}

        {/* Structured text rendering would go here */}
      </article>
      <PreviewBar />
    </>
  );
}
