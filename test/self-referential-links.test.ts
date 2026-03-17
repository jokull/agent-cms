import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Self-referential link fields", () => {
  let handler: (req: Request) => Promise<Response>;
  let venueIds: string[];

  beforeEach(async () => {
    ({ handler } = createTestApp());

    const modelRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Venue",
      apiKey: "venue",
    });
    const model = await modelRes.json();

    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Name",
      apiKey: "name",
      fieldType: "string",
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Main Venue",
      apiKey: "main_venue",
      fieldType: "link",
      validators: { item_item_type: ["venue"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, {
      label: "Nearby Venues",
      apiKey: "nearby_venues",
      fieldType: "links",
      validators: { items_item_type: ["venue"] },
    });

    // Create venues without links first
    venueIds = [];
    for (const name of ["Harpa", "Laugardalslaug", "Perlan"]) {
      const res = await (
        await jsonRequest(handler, "POST", "/api/records", {
          modelApiKey: "venue",
          data: { name },
        })
      ).json();
      venueIds.push(res.id);
    }
  });

  it("resolves a single self-referential link", async () => {
    // Laugardalslaug links to Harpa as mainVenue
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[1]}`, {
      modelApiKey: "venue",
      data: { main_venue: venueIds[0] },
    });

    const result = await gqlQuery(
      handler,
      `{
        allVenues(filter: { name: { eq: "Laugardalslaug" } }) {
          name
          mainVenue { id name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    const venue = result.data.allVenues[0];
    expect(venue.name).toBe("Laugardalslaug");
    expect(venue.mainVenue.name).toBe("Harpa");
    expect(venue.mainVenue.id).toBe(venueIds[0]);
  });

  it("resolves a self-referential links (multi) field", async () => {
    // Harpa's nearby venues are Laugardalslaug and Perlan
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[0]}`, {
      modelApiKey: "venue",
      data: { nearby_venues: [venueIds[1], venueIds[2]] },
    });

    const result = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[0]}") {
          name
          nearbyVenues { id name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    const venue = result.data.venue;
    expect(venue.name).toBe("Harpa");
    expect(venue.nearbyVenues).toHaveLength(2);
    expect(venue.nearbyVenues[0].name).toBe("Laugardalslaug");
    expect(venue.nearbyVenues[1].name).toBe("Perlan");
  });

  it("preserves insertion order in links array", async () => {
    // Set nearby_venues in reverse order: Perlan, Harpa
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[1]}`, {
      modelApiKey: "venue",
      data: { nearby_venues: [venueIds[2], venueIds[0]] },
    });

    const result = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[1]}") {
          nearbyVenues { name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.venue.nearbyVenues[0].name).toBe("Perlan");
    expect(result.data.venue.nearbyVenues[1].name).toBe("Harpa");
  });

  it("returns null for self-referential link to non-existent record", async () => {
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[0]}`, {
      modelApiKey: "venue",
      data: { main_venue: "nonexistent-id" },
    });

    const result = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[0]}") { name mainVenue { name } }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.venue.mainVenue).toBeNull();
  });

  it("resolves reverse references on self-referential links", async () => {
    // Harpa and Laugardalslaug both link to Perlan as main_venue
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[0]}`, {
      modelApiKey: "venue",
      data: { main_venue: venueIds[2] },
    });
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[1]}`, {
      modelApiKey: "venue",
      data: { main_venue: venueIds[2] },
    });

    const result = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[2]}") {
          name
          _allReferencingVenues { name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    const perlan = result.data.venue;
    expect(perlan.name).toBe("Perlan");
    const refNames = perlan._allReferencingVenues.map((v: any) => v.name).sort();
    expect(refNames).toEqual(["Harpa", "Laugardalslaug"]);
  });

  it("handles bidirectional self-referential links", async () => {
    // Harpa and Perlan list each other as nearby
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[0]}`, {
      modelApiKey: "venue",
      data: { nearby_venues: [venueIds[2]] },
    });
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[2]}`, {
      modelApiKey: "venue",
      data: { nearby_venues: [venueIds[0]] },
    });

    const harpaResult = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[0]}") {
          name
          nearbyVenues { name }
        }
      }`,
      { includeDrafts: true },
    );

    const perlanResult = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[2]}") {
          name
          nearbyVenues { name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(harpaResult.errors).toBeUndefined();
    expect(perlanResult.errors).toBeUndefined();
    expect(harpaResult.data.venue.nearbyVenues[0].name).toBe("Perlan");
    expect(perlanResult.data.venue.nearbyVenues[0].name).toBe("Harpa");
  });

  it("handles a record linking to itself", async () => {
    // Edge case: a venue links to itself as its own main_venue
    await jsonRequest(handler, "PATCH", `/api/records/${venueIds[0]}`, {
      modelApiKey: "venue",
      data: { main_venue: venueIds[0] },
    });

    const result = await gqlQuery(
      handler,
      `{
        venue(id: "${venueIds[0]}") {
          id
          name
          mainVenue { id name }
        }
      }`,
      { includeDrafts: true },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.venue.mainVenue.id).toBe(venueIds[0]);
    expect(result.data.venue.mainVenue.name).toBe("Harpa");
  });
});
