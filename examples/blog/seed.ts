/**
 * Seed script: creates schema + content for the blog example.
 * Run with: npx tsx seed.ts
 *
 * Uses the CMS REST API on localhost:8787.
 */

const BASE = process.env.CMS_URL ?? "http://localhost:8787";
const EXTRA_POST_COUNT = Number(process.env.EXTRA_POST_COUNT ?? "24");

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok && res.status !== 409) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function seed() {
  console.log(`Seeding CMS at ${BASE}...`);

  // --- Models ---

  const siteSettings = await api("POST", "/api/models", {
    name: "Site Settings",
    apiKey: "site_settings",
    singleton: true,
  });
  const author = await api("POST", "/api/models", {
    name: "Author",
    apiKey: "author",
    singleton: true,
  });
  const category = await api("POST", "/api/models", {
    name: "Category",
    apiKey: "category",
  });
  const post = await api("POST", "/api/models", {
    name: "Post",
    apiKey: "post",
  });

  // Block types
  const heroSection = await api("POST", "/api/models", {
    name: "Hero Section",
    apiKey: "hero_section",
    isBlock: true,
  });
  const codeBlock = await api("POST", "/api/models", {
    name: "Code Block",
    apiKey: "code_block",
    isBlock: true,
  });
  const featureCard = await api("POST", "/api/models", {
    name: "Feature Card",
    apiKey: "feature_card",
    isBlock: true,
  });
  const featureGrid = await api("POST", "/api/models", {
    name: "Feature Grid",
    apiKey: "feature_grid",
    isBlock: true,
  });

  console.log("Models created");

  // --- Fields ---

  // site_settings
  await api("POST", `/api/models/${siteSettings.id}/fields`, {
    label: "Site Name",
    apiKey: "site_name",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${siteSettings.id}/fields`, {
    label: "Tagline",
    apiKey: "tagline",
    fieldType: "text",
  });
  await api("POST", `/api/models/${siteSettings.id}/fields`, {
    label: "Default SEO",
    apiKey: "default_seo",
    fieldType: "seo",
  });

  // author
  await api("POST", `/api/models/${author.id}/fields`, {
    label: "Name",
    apiKey: "name",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${author.id}/fields`, {
    label: "Bio",
    apiKey: "bio",
    fieldType: "text",
  });

  // category
  await api("POST", `/api/models/${category.id}/fields`, {
    label: "Name",
    apiKey: "name",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${category.id}/fields`, {
    label: "Slug",
    apiKey: "slug",
    fieldType: "slug",
    validators: { slug_source: "name" },
  });
  await api("POST", `/api/models/${category.id}/fields`, {
    label: "Description",
    apiKey: "description",
    fieldType: "text",
  });
  await api("POST", `/api/models/${category.id}/fields`, {
    label: "Icon",
    apiKey: "icon",
    fieldType: "string",
  });
  await api("POST", `/api/models/${category.id}/fields`, {
    label: "Sort Order",
    apiKey: "sort_order",
    fieldType: "integer",
  });

  // post
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Title",
    apiKey: "title",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Slug",
    apiKey: "slug",
    fieldType: "slug",
    validators: { slug_source: "title" },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Excerpt",
    apiKey: "excerpt",
    fieldType: "text",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Cover Image",
    apiKey: "cover_image",
    fieldType: "media",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Content",
    apiKey: "content",
    fieldType: "structured_text",
    validators: {
      structured_text_blocks: ["hero_section", "code_block", "feature_grid", "feature_card"],
    },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Author",
    apiKey: "author",
    fieldType: "link",
    validators: { item_item_type: ["author"] },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Category",
    apiKey: "category",
    fieldType: "link",
    validators: { item_item_type: ["category"] },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Related Posts",
    apiKey: "related_posts",
    fieldType: "links",
    validators: { items_item_type: ["post"] },
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Published Date",
    apiKey: "published_date",
    fieldType: "date",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Reading Time",
    apiKey: "reading_time",
    fieldType: "integer",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Featured",
    apiKey: "featured",
    fieldType: "boolean",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "SEO",
    apiKey: "seo_field",
    fieldType: "seo",
  });
  await api("POST", `/api/models/${post.id}/fields`, {
    label: "Gallery",
    apiKey: "gallery",
    fieldType: "media_gallery",
  });

  // hero_section block
  await api("POST", `/api/models/${heroSection.id}/fields`, {
    label: "Headline",
    apiKey: "headline",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${heroSection.id}/fields`, {
    label: "Subheadline",
    apiKey: "subheadline",
    fieldType: "text",
  });

  // code_block block
  await api("POST", `/api/models/${codeBlock.id}/fields`, {
    label: "Code",
    apiKey: "code",
    fieldType: "text",
    validators: { required: true },
  });
  await api("POST", `/api/models/${codeBlock.id}/fields`, {
    label: "Language",
    apiKey: "language",
    fieldType: "string",
  });
  await api("POST", `/api/models/${codeBlock.id}/fields`, {
    label: "Filename",
    apiKey: "filename",
    fieldType: "string",
  });

  // feature_card block
  await api("POST", `/api/models/${featureCard.id}/fields`, {
    label: "Title",
    apiKey: "title",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${featureCard.id}/fields`, {
    label: "Description",
    apiKey: "description",
    fieldType: "text",
  });
  await api("POST", `/api/models/${featureCard.id}/fields`, {
    label: "Details",
    apiKey: "details",
    fieldType: "structured_text",
    validators: {
      structured_text_blocks: ["code_block"],
    },
  });

  // feature_grid block
  await api("POST", `/api/models/${featureGrid.id}/fields`, {
    label: "Heading",
    apiKey: "heading",
    fieldType: "string",
    validators: { required: true },
  });
  await api("POST", `/api/models/${featureGrid.id}/fields`, {
    label: "Features",
    apiKey: "features",
    fieldType: "structured_text",
    validators: {
      structured_text_blocks: ["feature_card"],
      blocks_only: true,
    },
  });

  console.log("Fields created");

  // --- Content ---

  // Author
  const authorRecord = await api("POST", "/api/records", {
    modelApiKey: "author",
    data: {
      name: "Jokull Solberg",
      bio: "Building tools for the agentic web. Interested in how AI changes the way we create and manage content.",
    },
  });

  // Site settings
  const settingsRecord = await api("POST", "/api/records", {
    modelApiKey: "site_settings",
    data: {
      site_name: "Edge Currents",
      tagline: "Notes on building at the edge of what's possible",
      default_seo: {
        title: "Edge Currents",
        description: "A blog about edge computing, AI agents, and the future of content management",
      },
    },
  });

  // Categories
  const catEngineering = await api("POST", "/api/records", {
    modelApiKey: "category",
    data: {
      name: "Engineering",
      description: "Systems design, architecture patterns, and building things that work",
      icon: "cpu",
      sort_order: 1,
    },
  });
  const catThinking = await api("POST", "/api/records", {
    modelApiKey: "category",
    data: {
      name: "Thinking",
      description: "Ideas, observations, and mental models",
      icon: "lightbulb",
      sort_order: 2,
    },
  });
  const catPractice = await api("POST", "/api/records", {
    modelApiKey: "category",
    data: {
      name: "Practice",
      description: "Hands-on walkthroughs and lessons learned",
      icon: "wrench",
      sort_order: 3,
    },
  });

  console.log("Categories created");

  // --- Posts ---
  // Designed so that *semantic* queries find them even when no keywords match literally.
  //
  // Example: searching "how to make websites faster" should find the post about
  // edge computing even though it never uses the word "faster" or "websites".
  //
  // Example: searching "dealing with too much data" should find the post about
  // information overload even though it discusses attention and curation, not databases.

  function dast(...paragraphs: string[]) {
    return {
      value: {
        schema: "dast",
        document: {
          type: "root",
          children: paragraphs.map((text) => ({
            type: "paragraph",
            children: [{ type: "span", value: text }],
          })),
        },
      },
    };
  }

  function dastWithHeadings(
    sections: Array<{ heading?: string; paragraphs: string[] }>
  ) {
    const children: unknown[] = [];
    for (const section of sections) {
      if (section.heading) {
        children.push({
          type: "heading",
          level: 2,
          children: [{ type: "span", value: section.heading }],
        });
      }
      for (const p of section.paragraphs) {
        children.push({
          type: "paragraph",
          children: [{ type: "span", value: p }],
        });
      }
    }
    return {
      value: {
        schema: "dast",
        document: { type: "root", children },
      },
    };
  }

  function dastWithBlocks(
    sections: Array<{ heading?: string; paragraphs: string[] }>,
    blocks: Record<string, unknown>,
    blockOrder: string[],
  ) {
    const children: unknown[] = [];
    for (const blockId of blockOrder) {
      children.push({ type: "block", item: blockId });
    }
    for (const section of sections) {
      if (section.heading) {
        children.push({
          type: "heading",
          level: 2,
          children: [{ type: "span", value: section.heading }],
        });
      }
      for (const p of section.paragraphs) {
        children.push({
          type: "paragraph",
          children: [{ type: "span", value: p }],
        });
      }
    }
    return {
      value: {
        schema: "dast",
        document: { type: "root", children },
      },
      blocks,
    };
  }

  function nestedFeatureGridBlock(prefix: string, topic: string) {
    const gridId = `${prefix}-grid`;
    const cardAId = `${prefix}-card-a`;
    const cardBId = `${prefix}-card-b`;
    const cardACodeId = `${prefix}-card-a-code`;
    const cardBCodeId = `${prefix}-card-b-code`;

    return {
      id: gridId,
      value: {
        _type: "feature_grid",
        heading: `${topic} under load`,
        features: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: cardAId },
                { type: "block", item: cardBId },
              ],
            },
          },
          blocks: {
            [cardAId]: {
              _type: "feature_card",
              title: `${topic} path fan-out`,
              description: "A nested block tree is where preview resolvers stop being theoretical.",
              details: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ type: "span", value: "This card embeds another StructuredText field with its own block lookup." }],
                      },
                      { type: "block", item: cardACodeId },
                    ],
                  },
                },
                blocks: {
                  [cardACodeId]: {
                    _type: "code_block",
                    language: "sql",
                    filename: `${prefix}-fanout.sql`,
                    code: "SELECT * FROM block_feature_card WHERE _parent_block_id = ? ORDER BY id;",
                  },
                },
              },
            },
            [cardBId]: {
              _type: "feature_card",
              title: `${topic} index coverage`,
              description: "Nested blocks should prefer indexed ancestry lookups over table scans.",
              details: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ type: "span", value: "Repeated nested selections are useful only if the SQL shape stays narrow." }],
                      },
                      { type: "block", item: cardBCodeId },
                    ],
                  },
                },
                blocks: {
                  [cardBCodeId]: {
                    _type: "code_block",
                    language: "sql",
                    filename: `${prefix}-lookup.sql`,
                    code: "CREATE INDEX idx_block_feature_card_lookup ON block_feature_card(_root_record_id, _root_field_api_key, _parent_container_model_api_key, _parent_field_api_key, _parent_block_id);",
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  function buildComplexContent(
    prefix: string,
    topic: string,
    sections: Array<{ heading?: string; paragraphs: string[] }>,
    options?: { includeTopLevelCode?: boolean }
  ) {
    const heroId = `${prefix}-hero`;
    const leadCodeId = `${prefix}-lead-code`;
    const featureGrid = nestedFeatureGridBlock(prefix, topic);
    const blockOrder = [heroId, featureGrid.id];
    const blocks: Record<string, unknown> = {
      [heroId]: {
        _type: "hero_section",
        headline: `${topic} benchmark fixture`,
        subheadline: "This record intentionally stresses recursive StructuredText resolution.",
      },
      [featureGrid.id]: featureGrid.value,
    };

    if (options?.includeTopLevelCode !== false) {
      blockOrder.push(leadCodeId);
      blocks[leadCodeId] = {
        _type: "code_block",
        language: "ts",
        filename: `${prefix}.ts`,
        code: "await cms.fetch('http://cms/graphql', { method: 'POST', body: JSON.stringify({ query }) });",
      };
    }

    return dastWithBlocks(sections, blocks, blockOrder);
  }

  // Post 1: About edge computing — searchable by "low latency" or "close to users"
  // but never mentions "fast" or "speed"
  const post1 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "Computation at the Periphery",
      excerpt:
        "Moving logic to the network's outer nodes changes what's architecturally possible.",
      content: buildComplexContent(
        "post1",
        "Edge locality",
        [
          {
            paragraphs: [
              "There's a quiet revolution happening in how we deploy server-side code. Instead of centralizing everything in a single region, platforms like Cloudflare Workers distribute your application across hundreds of points of presence worldwide.",
              "The implications go beyond mere geography. When your code runs within milliseconds of the person requesting it, entire categories of architectural compromise disappear. You no longer need aggressive caching strategies to compensate for distance. You no longer need to choose which continent gets the best experience.",
            ],
          },
          {
            heading: "The D1 Proposition",
            paragraphs: [
              "SQLite databases replicated to the edge via D1 mean your data lives where your code runs. Each request reads from a local replica. Writes propagate through a coordination layer that maintains consistency without sacrificing read locality.",
              "For content-heavy applications — blogs, documentation sites, marketing pages — the read-to-write ratio is so skewed that this model is nearly ideal. A CMS might process one write for every ten thousand reads. Those ten thousand reads all hit local replicas.",
            ],
          },
          {
            heading: "Rethinking the Stack",
            paragraphs: [
              "When your runtime, database, object storage, and image processing all run on the same global network, the traditional notion of a backend evaporates. There's no origin server to protect, no CDN to configure, no cache invalidation to debug.",
              "This isn't about replacing existing tools. It's about recognizing that the constraints those tools were designed around — centralized compute, expensive bandwidth, slow intercontinental links — are dissolving.",
            ],
          },
        ]
      ),
      author: authorRecord.id,
      category: catEngineering.id,
      published_date: "2025-10-15",
      reading_time: 6,
      featured: true,
      seo_field: {
        title: "Computation at the Periphery",
        description:
          "How distributing server-side logic across the network's outer nodes changes what's architecturally possible",
      },
    },
  });

  // Post 2: About information overload — searchable by "too much content"
  // or "drowning in feeds" but discusses attention economy, curation
  const post2 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "The Curation Deficit",
      excerpt:
        "We solved distribution. We haven't solved discovery. The abundance of published material creates a new kind of scarcity.",
      content: dastWithHeadings([
        {
          paragraphs: [
            "Every day, millions of articles, videos, and podcasts enter the public record. The machinery of distribution — social platforms, recommendation algorithms, email newsletters — ensures that producing content is no longer the bottleneck. Reaching an audience is trivially solved.",
            "What remains unsolved is the inverse problem: given the firehose of available material, how does a reader find the signal? Algorithmic feeds optimize for engagement, which correlates poorly with lasting value. Subscription models create obligation without guaranteeing relevance.",
          ],
        },
        {
          heading: "Attention as a Finite Resource",
          paragraphs: [
            "Herbert Simon observed in 1971 that a wealth of information creates a poverty of attention. Fifty years later, the imbalance has only deepened. The average knowledge worker encounters hundreds of potentially relevant documents per week, yet has capacity to deeply engage with perhaps a dozen.",
            "The consequence is a paradox of choice applied to intellectual life. Having access to everything is functionally equivalent to having access to nothing if you lack the means to navigate it.",
          ],
        },
        {
          heading: "Toward Intentional Consumption",
          paragraphs: [
            "The emerging response is a shift from passive consumption to active curation. Tools that help people maintain reading lists, annotate and connect ideas, and resurface material at the right moment are gaining traction not because they're novel, but because the need has become acute.",
            "A CMS designed for the agentic era should participate in this shift. Rather than merely publishing into the void, it should make its content discoverable through semantic understanding — surfacing pieces not by keyword coincidence but by conceptual relevance.",
          ],
        },
      ]),
      author: authorRecord.id,
      category: catThinking.id,
      published_date: "2025-11-02",
      reading_time: 5,
      featured: false,
      seo_field: {
        title: "The Curation Deficit",
        description:
          "We solved distribution but not discovery — abundance creates a new kind of scarcity",
      },
    },
  });

  // Post 3: About type safety — searchable by "catching bugs early" or
  // "preventing mistakes" but discusses schemas, contracts, compile-time guarantees
  const post3 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "Contracts All the Way Down",
      excerpt:
        "How typed schemas at every boundary — database, API, client — eliminate entire classes of runtime failure.",
      content: dastWithHeadings([
        {
          paragraphs: [
            "The most expensive bugs are the ones that cross boundaries. A field renamed in the database but not in the API. A nullable column treated as required by the frontend. A JSON payload that almost matches the expected shape. These failures are invisible at development time and catastrophic in production.",
          ],
        },
        {
          heading: "The Type Sandwich",
          paragraphs: [
            "In agent-cms, we use a pattern we call the type sandwich. The top layer — system tables like models and fields — is statically typed with TypeScript interfaces. The bottom layer — field type definitions with their SQL types, GraphQL types, and validation schemas — is also statically typed. The middle layer — which fields exist on which models — is dynamic, defined at runtime by the CMS schema.",
            "This architecture means that even though the content schema is user-defined, every field value passes through a statically known validation pipeline. The system can't produce a color field that isn't {red, green, blue, alpha}. It can't store a lat_lon without valid coordinates. The dynamic middle layer is sandwiched between static guarantees.",
          ],
        },
        {
          heading: "Extending to the Client",
          paragraphs: [
            "GraphQL introspection carries these contracts to the frontend. Tools like gql.tada read the introspected schema and generate TypeScript types for every query. A renamed field in the CMS produces a compile error in the Astro component, not a blank page in production.",
            "The result is a system where the distance between making a change and knowing its consequences is as short as possible. Not zero — some things can only be caught at runtime — but dramatically shorter than the alternative of discovering mismatches through user reports.",
          ],
        },
      ]),
      author: authorRecord.id,
      category: catEngineering.id,
      published_date: "2025-11-20",
      reading_time: 7,
      featured: true,
      seo_field: {
        title: "Contracts All the Way Down",
        description:
          "Typed schemas at every boundary eliminate entire classes of runtime failure",
      },
    },
  });

  // Post 4: About AI agents managing content — searchable by "AI writing"
  // or "automated publishing" but discusses agency, delegation, trust
  const post4 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "Delegation and Trust in Automated Systems",
      excerpt:
        "When an AI agent manages your CMS, the question isn't capability — it's governance.",
      content: dastWithHeadings([
        {
          paragraphs: [
            "The first reaction to an agent-managed CMS is usually about capability. Can it write good content? Can it choose appropriate images? Can it structure information effectively? These are important questions, but they're not the hard ones.",
            "The hard questions are about governance. Who reviews what the agent publishes? How do you audit changes? What happens when the agent's judgment diverges from editorial policy? These are organizational problems wearing technical costumes.",
          ],
        },
        {
          heading: "The Spectrum of Autonomy",
          paragraphs: [
            "Not every task requires the same level of oversight. Updating a publish date, generating a slug, resizing an image — these are purely mechanical operations where human review adds no value. Drafting a headline, choosing a category, writing an excerpt — these require judgment but have low blast radius. Publishing a major announcement, restructuring the content model, deleting records — these demand explicit approval.",
            "A well-designed agent system should map its operations onto this spectrum. The MCP protocol helps here: each tool call is visible, auditable, and can be gated by permission levels. Draft creation can be autonomous. Publishing can require confirmation.",
          ],
        },
        {
          heading: "Building Trust Incrementally",
          paragraphs: [
            "Trust in automated systems is earned the same way trust in people is earned: through a track record of good judgment in progressively higher-stakes situations. Start by letting the agent handle metadata — SEO fields, reading times, categorization. Graduate to content drafts that humans review. Eventually, for low-risk content types, allow end-to-end autonomy.",
            "The CMS architecture should support this progression. Audit logs, draft/publish separation, webhook notifications, and schema-level constraints all serve as guardrails that make delegation safe without making it burdensome.",
          ],
        },
      ]),
      author: authorRecord.id,
      category: catThinking.id,
      published_date: "2025-12-05",
      reading_time: 6,
      featured: false,
      seo_field: {
        title: "Delegation and Trust in Automated Systems",
        description:
          "When AI agents manage content, the question isn't capability — it's governance",
      },
    },
  });

  // Post 5: About structured content — searchable by "headless CMS"
  // but discusses separation of concerns, portability, DAST trees
  const post5 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "Content as a Data Structure",
      excerpt:
        "Why separating content from presentation isn't just an architectural choice — it's a prerequisite for the multi-channel future.",
      content: dastWithHeadings([
        {
          paragraphs: [
            "When content lives inside a template — embedded in HTML, tangled with CSS classes, coupled to a specific rendering engine — it can only exist in one form. Move it to a different channel and you're copying and pasting, reformatting, re-entering. The content is held hostage by its container.",
          ],
        },
        {
          heading: "The DAST Advantage",
          paragraphs: [
            "Structured text formats like DAST (Document Abstract Syntax Tree) represent content as a tree of typed nodes — paragraphs, headings, lists, embedded blocks — without any rendering assumptions. The same DAST document can be rendered as HTML for the web, Markdown for documentation, plain text for search indexing, or native components for a mobile app.",
            "This isn't theoretical. In this CMS, a single structured text field simultaneously feeds the Astro frontend (HTML), the GraphQL API (JSON), the search index (plain text), and potentially an email newsletter or RSS feed. The content is written once and rendered everywhere.",
          ],
        },
        {
          heading: "Blocks as Composable Units",
          paragraphs: [
            "The block system extends this principle. A hero section, a code snippet, an image gallery — these are typed data structures with their own schemas. The frontend decides how to render them. A marketing site might render a hero block as a full-bleed banner. A mobile app might render it as a card. An accessibility-focused reader might skip it entirely.",
            "The content creator doesn't need to think about rendering. They assemble blocks that carry meaning. The consumption layer decides how that meaning becomes visible.",
          ],
        },
      ]),
      author: authorRecord.id,
      category: catPractice.id,
      published_date: "2026-01-10",
      reading_time: 5,
      featured: false,
      seo_field: {
        title: "Content as a Data Structure",
        description:
          "Separating content from presentation is a prerequisite for the multi-channel future",
      },
    },
  });

  // Post 6: About search itself — searchable by "finding things"
  // but discusses relevance, ranking, semantic gaps
  const post6 = await api("POST", "/api/records", {
    modelApiKey: "post",
    data: {
      title: "Beyond Keyword Matching",
      excerpt:
        "Why traditional search fails for content discovery and what comes next.",
      content: buildComplexContent(
        "post6",
        "Search retrieval",
        [
          {
            paragraphs: [
              "Type a query into a search box and you get back documents containing those exact words. This is keyword matching, and it's been the dominant paradigm since the early days of information retrieval. It works well when you know the precise terminology — searching for an error message, a function name, a specific phrase.",
              "It fails spectacularly when you don't. Searching for 'how to make my site load instantly' won't find an article about edge computing that discusses latency reduction and geographic distribution but never uses the word 'instantly.' Searching for 'dealing with burnout' won't find a piece about sustainable pace and attention management.",
            ],
          },
          {
            heading: "The Vocabulary Mismatch Problem",
            paragraphs: [
              "Information retrieval researchers call this the vocabulary mismatch problem. Authors and searchers often use different words to describe the same concept. A document about 'distributed consensus' is relevant to someone searching for 'how databases stay consistent' but shares almost no keywords with the query.",
              "FTS5, the full-text search engine built into SQLite, is a keyword matcher. It's excellent at what it does: BM25 ranking, phrase search, prefix matching. But it can only find what's literally there.",
            ],
          },
          {
            heading: "Semantic Understanding",
            paragraphs: [
              "Vector search addresses the vocabulary mismatch by operating on meaning rather than tokens. Both the query and the document are converted to numerical representations — embeddings — that capture semantic content. Documents about similar concepts cluster together in this vector space, regardless of the specific words used.",
              "The combination of keyword search and vector search — hybrid retrieval — gives you the best of both worlds. Exact matches surface when the terminology aligns. Conceptual matches surface when it doesn't. The result is a search experience that feels like it understands what you're looking for, not just what you typed.",
            ],
          },
        ],
        { includeTopLevelCode: true }
      ),
      author: authorRecord.id,
      category: catEngineering.id,
      published_date: "2026-02-14",
      reading_time: 5,
      featured: true,
      seo_field: {
        title: "Beyond Keyword Matching",
        description:
          "Why traditional search fails for content discovery and what semantic search makes possible",
      },
    },
  });

  const bulkTopics = [
    {
      title: "Replica-Aware Reads",
      excerpt: "What changes when your read path lands on local replicas but your write path remains coordinated.",
      category: catEngineering.id,
      featured: false,
      sections: [
        {
          paragraphs: [
            "Read-heavy content systems rarely fail because a single query is complex. They fail because a seemingly harmless query shape is executed at volume, on every page view, across a global audience.",
            "Replica-aware architectures help only if the application side avoids broad scans and redundant statement churn.",
          ],
        },
        {
          heading: "Measure The Read Path",
          paragraphs: [
            "A benchmark fixture should capture the exact GraphQL fields the frontend asks for, not an abstract SQL microbenchmark divorced from resolver behavior.",
          ],
        },
      ],
    },
    {
      title: "Resolver Fan-Out Control",
      excerpt: "GraphQL flexibility is useful only if resolver fan-out stays proportional to the requested shape.",
      category: catPractice.id,
      featured: false,
      sections: [
        {
          paragraphs: [
            "Nested content models create the illusion of a single object graph, but operationally they are a sequence of statement batches with their own lookup patterns.",
            "The right benchmark does not ask whether recursion works. It asks how many round-trips and scans it creates.",
          ],
        },
        {
          heading: "Shape Before Speed",
          paragraphs: [
            "An indexed bad shape is still a bad shape. Fixing planner behavior and fixing resolver batching are different iterations and should be measured separately.",
          ],
        },
      ],
    },
    {
      title: "Schema Drift Is A Benchmark Bug",
      excerpt: "If your deployed example diverges from the repo schema, every result you record becomes suspect.",
      category: catThinking.id,
      featured: true,
      sections: [
        {
          paragraphs: [
            "A stale benchmark environment creates fake wins and fake regressions. The first job is reestablishing equivalence between code, schema, and data.",
          ],
        },
        {
          heading: "Reset, Seed, Measure",
          paragraphs: [
            "Treat the example deployment as disposable infrastructure. Rebuild it from source so the benchmark target is a controlled fixture, not an archaeological site.",
          ],
        },
      ],
    },
    {
      title: "Recursive Blocks In Practice",
      excerpt: "Three levels of nested StructuredText tell you more about resolver scaling than a thousand flat records.",
      category: catEngineering.id,
      featured: false,
      sections: [
        {
          paragraphs: [
            "The interesting failure mode is not root-level block lookup. It is nested block lookup repeated for every selected parent block across a result set.",
          ],
        },
        {
          heading: "Benchmark The Worst Honest Shape",
          paragraphs: [
            "If a query will exist in production, it belongs in the benchmark suite even if it looks expensive. Especially then.",
          ],
        },
      ],
    },
  ];

  const extraPosts = [];
  for (let i = 0; i < EXTRA_POST_COUNT; i++) {
    const topic = bulkTopics[i % bulkTopics.length];
    const month = String((i % 12) + 1).padStart(2, "0");
    const day = String((i % 27) + 1).padStart(2, "0");
    const year = 2026 + Math.floor(i / 12);
    const title = `${topic.title} ${String(i + 1).padStart(2, "0")}`;
    const record = await api("POST", "/api/records", {
      modelApiKey: "post",
      data: {
        title,
        excerpt: topic.excerpt,
        content: buildComplexContent(
          `bulk${i + 1}`,
          topic.title,
          topic.sections,
          { includeTopLevelCode: i % 3 !== 0 }
        ),
        author: authorRecord.id,
        category: topic.category,
        published_date: `${year}-${month}-${day}`,
        reading_time: 4 + (i % 5),
        featured: topic.featured && i % 2 === 0,
        seo_field: {
          title,
          description: topic.excerpt,
        },
      },
    });
    extraPosts.push(record);
  }

  console.log(`Posts created (${6 + extraPosts.length} total)`);

  // --- Publish all records ---
  const allRecordIds = [
    { id: settingsRecord.id, model: "site_settings" },
    { id: authorRecord.id, model: "author" },
    { id: catEngineering.id, model: "category" },
    { id: catThinking.id, model: "category" },
    { id: catPractice.id, model: "category" },
    { id: post1.id, model: "post" },
    { id: post2.id, model: "post" },
    { id: post3.id, model: "post" },
    { id: post4.id, model: "post" },
    { id: post5.id, model: "post" },
    { id: post6.id, model: "post" },
    ...extraPosts.map((post) => ({ id: post.id, model: "post" })),
  ];

  for (const { id, model } of allRecordIds) {
    await api("POST", `/api/records/${id}/publish?modelApiKey=${model}`);
  }

  console.log("All records published");

  // --- Verify search ---
  console.log("\nSearch verification:");

  // Keyword match: "edge" should find posts mentioning edge
  const r1 = await api("POST", "/api/search", { query: "edge" });
  console.log(`  "edge" → ${r1.results.length} result(s)`);

  // Keyword match: "curation" should find the curation deficit post
  const r2 = await api("POST", "/api/search", { query: "curation" });
  console.log(`  "curation" → ${r2.results.length} result(s)`);

  // Keyword match: "DAST" should find the content-as-data post
  const r3 = await api("POST", "/api/search", { query: "DAST" });
  console.log(`  "DAST" → ${r3.results.length} result(s)`);

  // Phrase match
  const r4 = await api("POST", "/api/search", {
    query: '"type sandwich"',
  });
  console.log(`  '"type sandwich"' → ${r4.results.length} result(s)`);

  // Cross-model search
  const r5 = await api("POST", "/api/search", { query: "content" });
  console.log(`  "content" (cross-model) → ${r5.results.length} result(s)`);

  console.log(`\nDone! CMS seeded with ${6 + extraPosts.length} posts, 3 categories, nested blocks, and FTS5 search index.`);
  console.log(
    "\nQueries that would benefit from vector search (no literal keyword match):"
  );
  console.log(
    '  "how to make websites faster" → 0 FTS results (post about edge computing uses different vocabulary)'
  );
  console.log(
    '  "dealing with too much information" → 0 FTS results (post about curation deficit discusses attention, not "information")'
  );
  console.log(
    '  "catching bugs before production" → 0 FTS results (post about type contracts uses "failure" not "bugs")'
  );
  console.log(
    '  "letting AI handle publishing" → 0 FTS results (post about delegation uses "governance" not "handle")'
  );
}

seed().catch((e) => {
  console.error(e);
  process.exit(1);
});
