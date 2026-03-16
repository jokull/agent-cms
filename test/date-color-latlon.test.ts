import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

describe("Date, DateTime, Color, and LatLon field types", () => {
  let handler: (req: Request) => Promise<Response>;

  describe("date and date_time fields", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Event", apiKey: "event" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Date", apiKey: "event_date", fieldType: "date" });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Start Time", apiKey: "start_time", fieldType: "date_time" });
    });

    it("stores and retrieves date and date_time values", async () => {
      const res = await (await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "event",
        data: { title: "Conference", event_date: "2025-06-15", start_time: "2025-06-15T09:00:00Z" },
      })).json();

      expect(res.event_date).toBe("2025-06-15");
      expect(res.start_time).toBe("2025-06-15T09:00:00Z");
    });

    it("resolves date fields in GraphQL as String", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "event",
        data: { title: "Meetup", event_date: "2025-03-20", start_time: "2025-03-20T18:30:00Z" },
      });

      const result = await gqlQuery(handler, `{
        allEvents { title event_date start_time }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const event = result.data.allEvents[0];
      expect(event.event_date).toBe("2025-03-20");
      expect(event.start_time).toBe("2025-03-20T18:30:00Z");
    });

    it("supports date filtering and ordering", async () => {
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "event", data: { title: "Early", event_date: "2025-01-01" } });
      await jsonRequest(handler, "POST", "/api/records", { modelApiKey: "event", data: { title: "Late", event_date: "2025-12-31" } });

      const result = await gqlQuery(handler, `{
        allEvents(orderBy: [event_date_ASC]) { title event_date }
      }`, { includeDrafts: true });

      expect(result.data.allEvents[0].title).toBe("Early");
      expect(result.data.allEvents[1].title).toBe("Late");
    });
  });

  describe("color field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Theme", apiKey: "theme" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Primary Color", apiKey: "primary_color", fieldType: "color" });
    });

    it("stores and resolves color with computed hex in GraphQL", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "theme",
        data: { name: "Ocean", primary_color: { red: 0, green: 119, blue: 204 } },
      });

      const result = await gqlQuery(handler, `{
        allThemes { name primary_color { red green blue alpha hex } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const color = result.data.allThemes[0].primary_color;
      expect(color.red).toBe(0);
      expect(color.green).toBe(119);
      expect(color.blue).toBe(204);
      expect(color.hex).toBe("#0077cc");
      expect(color.alpha).toBeNull();
    });

    it("stores color with alpha channel", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "theme",
        data: { name: "Glass", primary_color: { red: 255, green: 255, blue: 255, alpha: 128 } },
      });

      const result = await gqlQuery(handler, `{
        allThemes { primary_color { red green blue alpha hex } }
      }`, { includeDrafts: true });

      expect(result.data.allThemes[0].primary_color.alpha).toBe(128);
      expect(result.data.allThemes[0].primary_color.hex).toBe("#ffffff");
    });

    it("rejects invalid color values via Effect Schema", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "theme",
        data: { name: "Bad", primary_color: { red: 300, green: 0, blue: 0 } },
      });
      expect(res.status).toBe(400);
    });

    it("returns null for unset color field", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "theme", data: { name: "Default" },
      });

      const result = await gqlQuery(handler, `{
        allThemes { primary_color { hex } }
      }`, { includeDrafts: true });

      expect(result.data.allThemes[0].primary_color).toBeNull();
    });
  });

  describe("lat_lon field", () => {
    beforeEach(async () => {
      ({ handler } = createTestApp());
      const modelRes = await jsonRequest(handler, "POST", "/api/models", { name: "Place", apiKey: "place" });
      const model = await modelRes.json();
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
      await jsonRequest(handler, "POST", `/api/models/${model.id}/fields`, { label: "Location", apiKey: "location", fieldType: "lat_lon" });
    });

    it("stores and resolves lat_lon in GraphQL", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "place",
        data: { name: "Reykjavik", location: { latitude: 64.1466, longitude: -21.9426 } },
      });

      const result = await gqlQuery(handler, `{
        allPlaces { name location { latitude longitude } }
      }`, { includeDrafts: true });

      expect(result.errors).toBeUndefined();
      const loc = result.data.allPlaces[0].location;
      expect(loc.latitude).toBeCloseTo(64.1466);
      expect(loc.longitude).toBeCloseTo(-21.9426);
    });

    it("rejects invalid coordinates via Effect Schema", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "place",
        data: { name: "Bad", location: { latitude: 100, longitude: 0 } },
      });
      expect(res.status).toBe(400);
    });

    it("rejects longitude out of range", async () => {
      const res = await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "place",
        data: { name: "Bad", location: { latitude: 0, longitude: 200 } },
      });
      expect(res.status).toBe(400);
    });

    it("returns null for unset lat_lon field", async () => {
      await jsonRequest(handler, "POST", "/api/records", {
        modelApiKey: "place", data: { name: "Nowhere" },
      });

      const result = await gqlQuery(handler, `{
        allPlaces { location { latitude longitude } }
      }`, { includeDrafts: true });

      expect(result.data.allPlaces[0].location).toBeNull();
    });
  });
});
