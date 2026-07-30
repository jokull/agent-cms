import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Nested typed blocks in StructuredText", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());
  });

  it("resolves typed blocks inside a block's structured_text field", async () => {
    // Inner block type: venue
    const venueRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venue = await venueRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Address", apiKey: "address", fieldType: "string",
    });

    // Outer block type: section (has a structured_text field that allows venue blocks)
    const sectionRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Section", apiKey: "section", isBlock: true,
    });
    const section = await sectionRes.json();
    await jsonRequest(handler, "POST", `/api/models/${section.id}/fields`, {
      label: "Heading", apiKey: "heading", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${section.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue"] },
    });

    // Content model: guide (has structured_text allowing section blocks)
    const guideRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide",
    });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["section"] },
    });

    // Create a guide record with nested blocks:
    // guide.content → section block → section.body → venue block
    const venueBlockId = "01NESTED_VENUE01";
    const sectionBlockId = "01NESTED_SECT01";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Reykjavik Food Guide",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: sectionBlockId },
              ],
            },
          },
          blocks: {
            [sectionBlockId]: {
              _type: "section",
              heading: "Downtown Restaurants",
              body: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      { type: "paragraph", children: [{ type: "span", value: "Here are our picks:" }] },
                      { type: "block", item: venueBlockId },
                    ],
                  },
                },
                blocks: {
                  [venueBlockId]: {
                    _type: "venue",
                    name: "Grillið",
                    address: "Hagatorg 107",
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(createRes.status).toBe(201);

    // Query with nested typed fragments
    const result = await gqlQuery(handler, `{
      allGuides {
        title
        content {
          value
          blocks {
            ... on SectionRecord {
              heading
              body {
                value
                blocks {
                  ... on VenueRecord {
                    name
                    address
                  }
                }
              }
            }
          }
        }
      }
    }`);

    console.log("GraphQL result:", JSON.stringify(result, null, 2));

    expect(result.errors).toBeUndefined();
    const g = result.data.allGuides[0];
    expect(g.title).toBe("Reykjavik Food Guide");
    expect(g.content.blocks).toHaveLength(1);

    const sectionBlock = g.content.blocks[0];
    expect(sectionBlock.heading).toBe("Downtown Restaurants");
    expect(sectionBlock.body).toBeDefined();
    expect(sectionBlock.body.blocks).toHaveLength(1);

    const venueBlock = sectionBlock.body.blocks[0];
    expect(venueBlock.name).toBe("Grillið");
    expect(venueBlock.address).toBe("Hagatorg 107");
  });

  // Regression for the single-UNION-ALL materialization (issue #61): a field
  // allowing MULTIPLE block models produces multiple UNION branches, and nesting
  // exercises the branch/param concatenation at more than one level at once.
  it("materializes multiple block models in one field plus nesting", async () => {
    // Two inner block types allowed in the nested field.
    const venueRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue", apiKey: "venue", isBlock: true,
    });
    const venue = await venueRes.json();
    await jsonRequest(handler, "POST", `/api/models/${venue.id}/fields`, {
      label: "Name", apiKey: "name", fieldType: "string",
    });
    const noteRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Note", apiKey: "note", isBlock: true,
    });
    const note = await noteRes.json();
    await jsonRequest(handler, "POST", `/api/models/${note.id}/fields`, {
      label: "Text", apiKey: "text", fieldType: "text",
    });

    // Outer block type with a nested ST field allowing BOTH inner block models.
    const sectionRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Section", apiKey: "section", isBlock: true,
    });
    const section = await sectionRes.json();
    await jsonRequest(handler, "POST", `/api/models/${section.id}/fields`, {
      label: "Heading", apiKey: "heading", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${section.id}/fields`, {
      label: "Body", apiKey: "body", fieldType: "structured_text",
      validators: { structured_text_blocks: ["venue", "note"] },
    });

    // A second top-level block type so the root field also spans >1 model.
    const calloutRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Callout", apiKey: "callout", isBlock: true,
    });
    const callout = await calloutRes.json();
    await jsonRequest(handler, "POST", `/api/models/${callout.id}/fields`, {
      label: "Message", apiKey: "message", fieldType: "string",
    });

    // Content model whose ST field allows both section and callout.
    const guideRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Guide", apiKey: "guide",
    });
    const guide = await guideRes.json();
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Title", apiKey: "title", fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${guide.id}/fields`, {
      label: "Content", apiKey: "content", fieldType: "structured_text",
      validators: { structured_text_blocks: ["section", "callout"] },
    });

    const sectionId = "01MULTI_SECTION1";
    const calloutId = "01MULTI_CALLOUT1";
    const venueId = "01MULTI_VENUE001";
    const noteId = "01MULTI_NOTE0001";

    const createRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "guide",
      data: {
        title: "Mixed Guide",
        content: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: sectionId },
                { type: "block", item: calloutId },
              ],
            },
          },
          blocks: {
            [sectionId]: {
              _type: "section",
              heading: "Places",
              body: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      { type: "block", item: venueId },
                      { type: "block", item: noteId },
                    ],
                  },
                },
                blocks: {
                  [venueId]: { _type: "venue", name: "Grillið" },
                  [noteId]: { _type: "note", text: "Reservations recommended" },
                },
              },
            },
            [calloutId]: { _type: "callout", message: "Enjoy!" },
          },
        },
      },
    });
    expect(createRes.status).toBe(201);

    const result = await gqlQuery(handler, `{
      allGuides {
        title
        content {
          blocks {
            __typename
            ... on SectionRecord {
              heading
              body {
                blocks {
                  __typename
                  ... on VenueRecord { name }
                  ... on NoteRecord { text }
                }
              }
            }
            ... on CalloutRecord { message }
          }
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const g = result.data.allGuides[0];
    expect(g.title).toBe("Mixed Guide");
    expect(g.content.blocks).toHaveLength(2);

    const sectionBlock = g.content.blocks.find((b: any) => b.__typename === "SectionRecord");
    expect(sectionBlock.heading).toBe("Places");
    expect(sectionBlock.body.blocks).toHaveLength(2);
    const venueBlock = sectionBlock.body.blocks.find((b: any) => b.__typename === "VenueRecord");
    const noteBlock = sectionBlock.body.blocks.find((b: any) => b.__typename === "NoteRecord");
    expect(venueBlock.name).toBe("Grillið");
    expect(noteBlock.text).toBe("Reservations recommended");

    const calloutBlock = g.content.blocks.find((b: any) => b.__typename === "CalloutRecord");
    expect(calloutBlock.message).toBe("Enjoy!");
  });
});
