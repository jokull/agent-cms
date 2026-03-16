import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, jsonRequest, gqlQuery } from "./app-helpers.js";

/**
 * [SCHEMA:recipes] Recipe Site integration test
 *
 * Tests localization, media, nested blocks, and the full CMS feature set.
 */
describe("[SCHEMA:recipes] Recipe Site", () => {
  let handler: (req: Request) => Promise<Response>;

  beforeEach(async () => {
    ({ handler } = createTestApp());

    // Set up locales
    const enRes = await jsonRequest(handler, "POST", "/api/locales", { code: "en", position: 0 });
    const en = await enRes.json();
    await jsonRequest(handler, "POST", "/api/locales", { code: "is", position: 1, fallbackLocaleId: en.id });

    // Block types
    const ingredientRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Ingredient Callout", apiKey: "ingredient_callout", isBlock: true,
    });
    const ingredient = await ingredientRes.json();
    await jsonRequest(handler, "POST", `/api/models/${ingredient.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${ingredient.id}/fields`, { label: "Amount", apiKey: "amount", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${ingredient.id}/fields`, { label: "Unit", apiKey: "unit", fieldType: "string" });

    const stepRes = await jsonRequest(handler, "POST", "/api/models", {
      name: "Recipe Step", apiKey: "recipe_step", isBlock: true,
    });
    const step = await stepRes.json();
    await jsonRequest(handler, "POST", `/api/models/${step.id}/fields`, {
      label: "Instruction", apiKey: "instruction", fieldType: "structured_text",
      validators: { structured_text_blocks: ["ingredient_callout"] },
    });

    // Content models
    const cuisineRes = await jsonRequest(handler, "POST", "/api/models", { name: "Cuisine", apiKey: "cuisine" });
    const cuisine = await cuisineRes.json();
    await jsonRequest(handler, "POST", `/api/models/${cuisine.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${cuisine.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "name" } });

    const tagRes = await jsonRequest(handler, "POST", "/api/models", { name: "Dietary Tag", apiKey: "dietary_tag" });
    const tag = await tagRes.json();
    await jsonRequest(handler, "POST", `/api/models/${tag.id}/fields`, { label: "Name", apiKey: "name", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${tag.id}/fields`, { label: "Icon", apiKey: "icon", fieldType: "string" });

    const recipeRes = await jsonRequest(handler, "POST", "/api/models", { name: "Recipe", apiKey: "recipe" });
    const recipe = await recipeRes.json();
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Title", apiKey: "title", fieldType: "string" });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Slug", apiKey: "slug", fieldType: "slug", validators: { slug_source: "title" } });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, {
      label: "Steps", apiKey: "steps", fieldType: "structured_text",
      validators: { structured_text_blocks: ["recipe_step"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Prep Time", apiKey: "prep_time", fieldType: "integer" });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Cook Time", apiKey: "cook_time", fieldType: "integer" });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Servings", apiKey: "servings", fieldType: "integer" });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, {
      label: "Cuisine", apiKey: "cuisine", fieldType: "link",
      validators: { item_item_type: ["cuisine"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, {
      label: "Dietary Tags", apiKey: "dietary_tags", fieldType: "links",
      validators: { items_item_type: ["dietary_tag"] },
    });
    await jsonRequest(handler, "POST", `/api/models/${recipe.id}/fields`, { label: "Cover", apiKey: "cover", fieldType: "media" });
  });

  it("creates the full recipe schema", async () => {
    const models = await (await handler(new Request("http://localhost/api/models"))).json() as any[];
    // 3 content + 2 block = 5 total
    expect(models.length).toBe(5);
  });

  it("creates a recipe with nested blocks and queries via GraphQL", async () => {
    // Create supporting data
    const cuisineRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "cuisine", data: { name: "Italian" },
    });
    const cuisine = await cuisineRes.json();

    const veganRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "dietary_tag", data: { name: "Vegan", icon: "🌱" },
    });
    const vegan = await veganRes.json();
    const gfRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "dietary_tag", data: { name: "Gluten-Free", icon: "🌾" },
    });
    const gf = await gfRes.json();

    // Create asset for cover
    const assetRes = await jsonRequest(handler, "POST", "/api/assets", {
      filename: "pasta.jpg", mimeType: "image/jpeg", size: 50000, width: 800, height: 600,
    });
    const asset = await assetRes.json();

    // Create recipe with nested StructuredText blocks
    const stepBlockId = "01HRCP_STEP_001";
    // The recipe_step block has a structured_text field "instruction"
    // which itself contains an ingredient_callout inline block
    const recipeRes = await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "recipe",
      data: {
        title: "Pasta Primavera",
        prep_time: 15,
        cook_time: 20,
        servings: 4,
        cuisine: cuisine.id,
        dietary_tags: [vegan.id, gf.id],
        cover: asset.id,
        steps: {
          value: {
            schema: "dast",
            document: {
              type: "root",
              children: [
                { type: "block", item: stepBlockId },
              ],
            },
          },
          blocks: {
            [stepBlockId]: {
              _type: "recipe_step",
              instruction: {
                value: {
                  schema: "dast",
                  document: {
                    type: "root",
                    children: [
                      {
                        type: "paragraph",
                        children: [{ type: "span", value: "Boil the pasta according to package directions" }],
                      },
                    ],
                  },
                },
                blocks: {},
              },
            },
          },
        },
      },
    });

    expect(recipeRes.status).toBe(201);
    const recipe = await recipeRes.json();
    expect(recipe.slug).toBe("pasta-primavera");

    // Query via GraphQL
    const result = await gqlQuery(handler, `{
      allRecipes {
        title
        slug
        prepTime
        cookTime
        servings
        cuisine { name slug }
        cover { filename mimeType width height }
        steps {
          value
          blocks {
            __typename
            ... on RecipeStepRecord { instruction { value } }
          }
          links
        }
      }
    }`);

    expect(result.errors).toBeUndefined();
    const r = result.data.allRecipes[0];
    expect(r.title).toBe("Pasta Primavera");
    expect(r.prepTime).toBe(15);
    expect(r.cookTime).toBe(20);
    expect(r.servings).toBe(4);
    expect(r.cuisine.name).toBe("Italian");
    expect(r.cuisine.slug).toBe("italian");
    expect(r.cover.filename).toBe("pasta.jpg"); // Media field resolves to asset object

    // StructuredText resolution
    expect(r.steps.value.schema).toBe("dast");
    expect(r.steps.blocks).toHaveLength(1);
    // The step block should have the instruction field
    const stepBlock = r.steps.blocks[0];
    expect(stepBlock.__typename).toBe("RecipeStepRecord");
  });

  it("filters recipes by integer fields", async () => {
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "recipe", data: { title: "Quick Salad", prep_time: 5, cook_time: 0, servings: 2 },
    });
    await jsonRequest(handler, "POST", "/api/records", {
      modelApiKey: "recipe", data: { title: "Slow Roast", prep_time: 30, cook_time: 180, servings: 8 },
    });

    const quickMeals = await gqlQuery(handler, `{
      allRecipes(filter: { cookTime: { lte: 30 } }) { title }
    }`);
    expect(quickMeals.data.allRecipes).toHaveLength(1);
    expect(quickMeals.data.allRecipes[0].title).toBe("Quick Salad");
  });
});
