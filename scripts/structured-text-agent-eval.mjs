#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { parse as parseDastdown, serialize as serializeDastdown } from "datocms-structured-text-dastdown";

const DEFAULT_MODEL = process.env.STRUCTURED_TEXT_EVAL_MODEL ?? "gpt-5.4-mini";
const DEFAULT_PROVIDER = process.env.STRUCTURED_TEXT_EVAL_PROVIDER ?? "dry";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHandleWhitespace(source) {
  return source
    .replace(/\[\[\s*block\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[block:$1]]")
    .replace(/\[\[\s*inline_block\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[inline_block:$1]]")
    .replace(/\[\[\s*inline_item\s*:\s*([^\]\s|]+)\s*\]\]/g, "[[inline_item:$1]]")
    .replace(/\[\[\s*record\s*:\s*([^\]\s|]+)\s*\|\s*([^\]]+?)\s*\]\]/g, "[[record:$1|$2]]");
}

function agentTextToInternalStructuredText(source) {
  return normalizeHandleWhitespace(source)
    .replace(/\[\[block:([^\]\s|]+)\]\]/g, '<block id="$1"/>')
    .replace(/\[\[inline_block:([^\]\s|]+)\]\]/g, '<inlineBlock id="$1"/>')
    .replace(/\[\[inline_item:([^\]\s|]+)\]\]/g, '<inlineItem id="$1"/>')
    .replace(/\[\[record:([^\]\s|]+)\|([^\]]+)\]\]/g, "[$2](dato:item/$1)");
}

function internalStructuredTextToAgentText(source) {
  return source
    .replace(/<block id="([^"]+)"\/>/g, "[[block:$1]]")
    .replace(/<inlineBlock id="([^"]+)"\/>/g, "[[inline_block:$1]]")
    .replace(/<inlineItem id="([^"]+)"\/>/g, "[[inline_item:$1]]")
    .replace(/\[([^\]]+)\]\(dato:item\/([^)]+)\)/g, "[[record:$2|$1]]");
}

export const FORMAT_CANDIDATES = [
  {
    name: "agentText",
    label: "Agent Text",
    instructions: "Use Agent Text. Preserve [[block:ID]], [[inline_block:ID]], [[inline_item:ID]], and [[record:ID|label]] handles exactly unless the task asks to move or remove them.",
    serialize: (doc) => internalStructuredTextToAgentText(serializeDastdown(clone(doc))),
    parse: (source) => parseDastdown(agentTextToInternalStructuredText(source)),
    sourceChecks: [
      { id: "no_html_comment_refs", description: "Did not emit HTML-comment reference markers", pass: (source) => !/<!--\s*cms:/.test(source) },
      { id: "no_lower_angle_ref_tags", description: "Did not emit lowercase angle-bracket reference tags", pass: (source) => !/<(?:block|inlineBlock|inlineItem)\b/.test(source) },
      { id: "no_upper_angle_ref_tags", description: "Did not emit uppercase angle-bracket reference tags", pass: (source) => !/<(?:Block|InlineBlock|InlineItem)\b/.test(source) },
      { id: "no_markdown_record_link_schemes", description: "Did not emit Markdown-link record reference schemes", pass: (source) => !/\]\((?:itemLink:|record:|dato:item\/)/.test(source) },
    ],
  },
];

export const baseArticleDoc = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      { type: "heading", level: 1, children: [{ type: "span", value: "A Weekend in Kyoto" }] },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Start at " },
          { type: "itemLink", item: "rec_kiyomizu", children: [{ type: "span", value: "Kiyomizu-dera" }] },
          { type: "span", value: " before the lanes get crowded." },
        ],
      },
      { type: "block", item: "hero_photo" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Save room for seasonal sweets " },
          { type: "inlineBlock", item: "sweet_tip" },
          { type: "span", value: " near the station." },
        ],
      },
    ],
  },
};

export const complexLandingDoc = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      { type: "heading", level: 1, children: [{ type: "span", value: "Spring Food Guide" }] },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Use this guide for " },
          { type: "itemLink", item: "rec_market", children: [{ type: "span", value: "Nishiki Market" }] },
          { type: "span", value: " and nearby snacks." },
        ],
      },
      { type: "block", item: "hero_photo" },
      {
        type: "list",
        style: "bulleted",
        children: [
          {
            type: "listItem",
            children: [
              {
                type: "paragraph",
                children: [
                  { type: "span", value: "Book lunch near " },
                  { type: "inlineItem", item: "rec_lunch_spot" },
                  { type: "span", value: " before noon." },
                ],
              },
            ],
          },
          {
            type: "listItem",
            children: [
              {
                type: "paragraph",
                children: [
                  { type: "span", value: "Keep the allergy warning " },
                  { type: "inlineBlock", item: "allergy_warning" },
                  { type: "span", value: " visible." },
                ],
              },
            ],
          },
        ],
      },
      { type: "block", item: "map_embed" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "End with the chef quote " },
          { type: "inlineBlock", item: "chef_quote" },
          { type: "span", value: " and do not edit it." },
        ],
      },
    ],
  },
};

export const ambiguousReferenceDoc = {
  schema: "dast",
  document: {
    type: "root",
    children: [
      { type: "heading", level: 1, children: [{ type: "span", value: "Autumn Launch Brief" }] },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Open with " },
          { type: "itemLink", item: "rec_arashiyama", children: [{ type: "span", value: "Arashiyama Guide" }] },
          { type: "span", value: " and keep " },
          { type: "itemLink", item: "rec_map_pack", children: [{ type: "span", value: "Map Pack" }] },
          { type: "span", value: " linked for planning." },
        ],
      },
      { type: "block", item: "hero_photo" },
      { type: "block", item: "hero_photo_mobile" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "Use the gallery " },
          { type: "inlineBlock", item: "gallery_teaser" },
          { type: "span", value: " before the route note " },
          { type: "inlineBlock", item: "route_note" },
          { type: "span", value: "." },
        ],
      },
      {
        type: "list",
        style: "bulleted",
        children: [
          {
            type: "listItem",
            children: [
              {
                type: "paragraph",
                children: [
                  { type: "span", value: "Confirm availability for " },
                  { type: "inlineItem", item: "rec_primary_hotel" },
                  { type: "span", value: " and not the backup." },
                ],
              },
            ],
          },
          {
            type: "listItem",
            children: [
              {
                type: "paragraph",
                children: [
                  { type: "span", value: "Mention backup option " },
                  { type: "inlineItem", item: "rec_primary_hotel_backup" },
                  { type: "span", value: " only once." },
                ],
              },
            ],
          },
        ],
      },
      { type: "block", item: "booking_widget" },
      { type: "block", item: "booking_widget_backup" },
      {
        type: "paragraph",
        children: [
          { type: "span", value: "End with CTA " },
          { type: "inlineBlock", item: "cta_signup" },
          { type: "span", value: " and legal note " },
          { type: "inlineBlock", item: "legal_note" },
          { type: "span", value: "." },
        ],
      },
    ],
  },
};

function span(value) {
  return { type: "span", value };
}

function itemLink(item, label) {
  return { type: "itemLink", item, children: [span(label)] };
}

function campaignSection(index) {
  const suffix = String(index).padStart(2, "0");
  return [
    {
      type: "paragraph",
      children: [
        span(`Day ${index} highlights `),
        itemLink(`rec_stop_${suffix}`, `Stop ${index}`),
        span(" with planning note "),
        { type: "inlineBlock", item: `note_${suffix}` },
        span("."),
      ],
    },
    { type: "block", item: `feature_${suffix}` },
    {
      type: "list",
      style: "bulleted",
      children: [
        {
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [
                span("Confirm booking "),
                { type: "inlineItem", item: `rec_booking_${suffix}` },
                span(" before publishing."),
              ],
            },
          ],
        },
        {
          type: "listItem",
          children: [
            {
              type: "paragraph",
              children: [
                span("Keep tip "),
                { type: "inlineBlock", item: `tip_${suffix}` },
                span(" beside this day."),
              ],
            },
          ],
        },
      ],
    },
  ];
}

function createCampaignDoc() {
  return {
    schema: "dast",
    document: {
      type: "root",
      children: [
        { type: "heading", level: 1, children: [span("Seven Day Kyoto Campaign")] },
        ...campaignSection(1),
        ...campaignSection(2),
        ...campaignSection(3),
        ...campaignSection(4),
        ...campaignSection(5),
        ...campaignSection(6),
        ...campaignSection(7),
        { type: "block", item: "cta_primary" },
        { type: "block", item: "cta_secondary" },
        {
          type: "paragraph",
          children: [
            span("Final reminder uses "),
            { type: "inlineBlock", item: "legal_note" },
            span(" and "),
            { type: "inlineBlock", item: "brand_note" },
            span("."),
          ],
        },
      ],
    },
  };
}

export const campaignDoc = createCampaignDoc();

function campaignOracleDoc() {
  const children = campaignDoc.document.children;
  return {
    schema: "dast",
    document: {
      type: "root",
      children: [
        { type: "heading", level: 1, children: [span("Kyoto Campaign Refresh")] },
        { type: "block", item: "cta_primary" },
        ...children.slice(1, 4),
        children[4],
        children[6],
        {
          type: "paragraph",
          children: [
            span("Day 3 now focuses on riverside shopping at "),
            itemLink("rec_stop_03", "Stop 3"),
            span(" with planning note "),
            { type: "inlineBlock", item: "note_03" },
            span("."),
          ],
        },
        children[8],
        children[9],
        ...children.slice(10, 19),
        children[19],
        children[21],
        { type: "block", item: "cta_secondary" },
        children[24],
      ],
    },
  };
}

export const SCENARIOS = [
  {
    id: "prose_edit_preserve_refs",
    title: "Edit prose while preserving CMS references",
    task: [
      "Change the title to \"48 Hours in Kyoto\".",
      "Change \"before the lanes get crowded\" to \"before the morning crowds arrive\".",
      "Do not remove, rename, or rewrite any CMS references.",
    ].join(" "),
    inputDoc: baseArticleDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "48 Hours in Kyoto" }] },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Start at " },
              { type: "itemLink", item: "rec_kiyomizu", children: [{ type: "span", value: "Kiyomizu-dera" }] },
              { type: "span", value: " before the morning crowds arrive." },
            ],
          },
          { type: "block", item: "hero_photo" },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Save room for seasonal sweets " },
              { type: "inlineBlock", item: "sweet_tip" },
              { type: "span", value: " near the station." },
            ],
          },
        ],
      },
    },
    checks: [
      { id: "title_updated", description: "Title changed to requested copy", pass: (doc) => text(doc).includes("48 Hours in Kyoto") },
      { id: "old_title_removed", description: "Old title removed", pass: (doc) => !text(doc).includes("A Weekend in Kyoto") },
      { id: "prose_updated", description: "Requested sentence changed", pass: (doc) => text(doc).includes("before the morning crowds arrive") },
      { id: "block_preserved", description: "Root block reference preserved", pass: (doc) => blockIds(doc).includes("hero_photo") },
      { id: "inline_block_preserved", description: "Inline block reference preserved", pass: (doc) => inlineBlockIds(doc).includes("sweet_tip") },
      { id: "item_link_preserved", description: "Record link preserved", pass: (doc) => itemLinkIds(doc).includes("rec_kiyomizu") },
    ],
  },
  {
    id: "translate_preserve_refs",
    title: "Translate text while preserving references",
    task: [
      "Translate all human-readable prose to Icelandic.",
      "Do not translate, remove, or modify CMS references or reference IDs.",
      "Keep the same structure and order.",
    ].join(" "),
    inputDoc: baseArticleDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "Helgi i Kyoto" }] },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Byrjaðu við " },
              { type: "itemLink", item: "rec_kiyomizu", children: [{ type: "span", value: "Kiyomizu-dera" }] },
              { type: "span", value: " áður en göturnar fyllast." },
            ],
          },
          { type: "block", item: "hero_photo" },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Skildu eftir pláss fyrir árstíðabundið sælgæti " },
              { type: "inlineBlock", item: "sweet_tip" },
              { type: "span", value: " nálægt stöðinni." },
            ],
          },
        ],
      },
    },
    checks: [
      { id: "english_changed", description: "Original English title changed", pass: (doc) => !text(doc).includes("A Weekend in Kyoto") },
      { id: "block_preserved", description: "Root block reference preserved", pass: (doc) => blockIds(doc).includes("hero_photo") },
      { id: "inline_block_preserved", description: "Inline block reference preserved", pass: (doc) => inlineBlockIds(doc).includes("sweet_tip") },
      { id: "item_link_preserved", description: "Record link ID preserved", pass: (doc) => itemLinkIds(doc).includes("rec_kiyomizu") },
      { id: "structure_count_preserved", description: "Top-level structure count preserved", pass: (doc) => doc.document.children.length === baseArticleDoc.document.children.length },
    ],
  },
  {
    id: "move_block",
    title: "Move a block without editing its payload",
    task: [
      "Move the hero_photo block to the end of the document.",
      "Keep all prose and inline references unchanged.",
      "Do not invent block payload fields.",
    ].join(" "),
    inputDoc: baseArticleDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "A Weekend in Kyoto" }] },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Start at " },
              { type: "itemLink", item: "rec_kiyomizu", children: [{ type: "span", value: "Kiyomizu-dera" }] },
              { type: "span", value: " before the lanes get crowded." },
            ],
          },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Save room for seasonal sweets " },
              { type: "inlineBlock", item: "sweet_tip" },
              { type: "span", value: " near the station." },
            ],
          },
          { type: "block", item: "hero_photo" },
        ],
      },
    },
    checks: [
      { id: "block_moved_to_end", description: "hero_photo is the final root node", pass: (doc) => doc.document.children.at(-1)?.type === "block" && doc.document.children.at(-1)?.item === "hero_photo" },
      { id: "only_one_hero_block", description: "hero_photo appears exactly once", pass: (doc) => blockIds(doc).filter((id) => id === "hero_photo").length === 1 },
      { id: "inline_block_preserved", description: "Inline block reference preserved", pass: (doc) => inlineBlockIds(doc).includes("sweet_tip") },
      { id: "item_link_preserved", description: "Record link preserved", pass: (doc) => itemLinkIds(doc).includes("rec_kiyomizu") },
    ],
  },
  {
    id: "complex_rewrite_reorder",
    title: "Rewrite a landing-page section while reordering blocks",
    task: [
      "Rewrite the title to \"Kyoto Spring Food Walk\".",
      "Rewrite the first paragraph to mention \"two-hour route\".",
      "Move the map_embed block immediately after the first paragraph.",
      "Keep hero_photo after map_embed.",
      "Keep allergy_warning and chef_quote inline blocks exactly where they are.",
      "Keep the rec_market link target and rec_lunch_spot inline item target unchanged.",
      "Do not invent or include block payload fields.",
    ].join(" "),
    inputDoc: complexLandingDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "Kyoto Spring Food Walk" }] },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Use this two-hour route for " },
              { type: "itemLink", item: "rec_market", children: [{ type: "span", value: "Nishiki Market" }] },
              { type: "span", value: " and nearby snacks." },
            ],
          },
          { type: "block", item: "map_embed" },
          { type: "block", item: "hero_photo" },
          {
            type: "list",
            style: "bulleted",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      { type: "span", value: "Book lunch near " },
                      { type: "inlineItem", item: "rec_lunch_spot" },
                      { type: "span", value: " before noon." },
                    ],
                  },
                ],
              },
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      { type: "span", value: "Keep the allergy warning " },
                      { type: "inlineBlock", item: "allergy_warning" },
                      { type: "span", value: " visible." },
                    ],
                  },
                ],
              },
            ],
          },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "End with the chef quote " },
              { type: "inlineBlock", item: "chef_quote" },
              { type: "span", value: " and do not edit it." },
            ],
          },
        ],
      },
    },
    checks: [
      { id: "title_updated", description: "Title rewritten", pass: (doc) => text(doc).includes("Kyoto Spring Food Walk") },
      { id: "route_added", description: "First paragraph mentions two-hour route", pass: (doc) => text(doc).includes("two-hour route") },
      { id: "block_order", description: "map_embed is immediately followed by hero_photo", pass: (doc) => rootBlockOrder(doc).join(",") === "map_embed,hero_photo" },
      { id: "map_once", description: "map_embed appears exactly once", pass: (doc) => blockIds(doc).filter((id) => id === "map_embed").length === 1 },
      { id: "hero_once", description: "hero_photo appears exactly once", pass: (doc) => blockIds(doc).filter((id) => id === "hero_photo").length === 1 },
      { id: "allergy_preserved", description: "allergy_warning inline block preserved", pass: (doc) => inlineBlockIds(doc).includes("allergy_warning") },
      { id: "chef_preserved", description: "chef_quote inline block preserved", pass: (doc) => inlineBlockIds(doc).includes("chef_quote") },
      { id: "record_link_preserved", description: "rec_market link preserved", pass: (doc) => itemLinkIds(doc).includes("rec_market") },
      { id: "inline_item_preserved", description: "rec_lunch_spot inline item preserved", pass: (doc) => itemLinkIds(doc).includes("rec_lunch_spot") },
      { id: "no_payload_json", description: "No block payload JSON leaked into prose", pass: (doc) => !text(doc).includes("_type") && !text(doc).includes("payload") },
    ],
  },
  {
    id: "delete_one_reference_only",
    title: "Delete one reference while preserving nearby references",
    task: [
      "Remove only the hero_photo block.",
      "Keep map_embed exactly where it is.",
      "Keep the allergy_warning and chef_quote inline blocks.",
      "Shorten the title to \"Spring Food Walk\".",
      "Do not remove record links or inline items.",
    ].join(" "),
    inputDoc: complexLandingDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "Spring Food Walk" }] },
          complexLandingDoc.document.children[1],
          complexLandingDoc.document.children[3],
          { type: "block", item: "map_embed" },
          complexLandingDoc.document.children[5],
        ],
      },
    },
    checks: [
      { id: "title_shortened", description: "Title shortened", pass: (doc) => text(doc).includes("Spring Food Walk") && !text(doc).includes("Spring Food Guide") },
      { id: "hero_removed", description: "hero_photo removed", pass: (doc) => !blockIds(doc).includes("hero_photo") },
      { id: "map_preserved_once", description: "map_embed preserved once", pass: (doc) => blockIds(doc).filter((id) => id === "map_embed").length === 1 },
      { id: "allergy_preserved", description: "allergy_warning inline block preserved", pass: (doc) => inlineBlockIds(doc).includes("allergy_warning") },
      { id: "chef_preserved", description: "chef_quote inline block preserved", pass: (doc) => inlineBlockIds(doc).includes("chef_quote") },
      { id: "record_link_preserved", description: "rec_market link preserved", pass: (doc) => itemLinkIds(doc).includes("rec_market") },
      { id: "inline_item_preserved", description: "rec_lunch_spot inline item preserved", pass: (doc) => itemLinkIds(doc).includes("rec_lunch_spot") },
    ],
  },
  {
    id: "ambiguous_reference_stress",
    title: "Edit a dense page with confusable reference IDs",
    task: [
      "Change the title to \"Autumn Kyoto Launch\".",
      "Rewrite the first paragraph to mention \"agent-managed itinerary\" while preserving both record links and their labels.",
      "Remove only hero_photo_mobile, not hero_photo.",
      "Remove only booking_widget_backup, not booking_widget.",
      "Move booking_widget so it appears immediately after hero_photo.",
      "Keep gallery_teaser before route_note.",
      "Keep rec_primary_hotel and rec_primary_hotel_backup as separate inline items.",
      "Keep cta_signup before legal_note.",
      "Do not rename similar IDs, collapse backup IDs into primary IDs, or invent block payload fields.",
    ].join(" "),
    inputDoc: ambiguousReferenceDoc,
    oracleDoc: {
      schema: "dast",
      document: {
        type: "root",
        children: [
          { type: "heading", level: 1, children: [{ type: "span", value: "Autumn Kyoto Launch" }] },
          {
            type: "paragraph",
            children: [
              { type: "span", value: "Open with " },
              { type: "itemLink", item: "rec_arashiyama", children: [{ type: "span", value: "Arashiyama Guide" }] },
              { type: "span", value: " and keep " },
              { type: "itemLink", item: "rec_map_pack", children: [{ type: "span", value: "Map Pack" }] },
              { type: "span", value: " linked for the agent-managed itinerary." },
            ],
          },
          { type: "block", item: "hero_photo" },
          { type: "block", item: "booking_widget" },
          ambiguousReferenceDoc.document.children[4],
          ambiguousReferenceDoc.document.children[5],
          ambiguousReferenceDoc.document.children[8],
        ],
      },
    },
    checks: [
      { id: "title_updated", description: "Title changed to launch copy", pass: (doc) => text(doc).includes("Autumn Kyoto Launch") },
      { id: "itinerary_added", description: "First paragraph mentions agent-managed itinerary", pass: (doc) => text(doc).includes("agent-managed itinerary") },
      { id: "root_block_order", description: "Remaining root blocks are hero_photo then booking_widget", pass: (doc) => rootBlockOrder(doc).join(",") === "hero_photo,booking_widget" },
      { id: "mobile_hero_removed", description: "Only mobile hero was removed", pass: (doc) => !blockIds(doc).includes("hero_photo_mobile") && blockIds(doc).includes("hero_photo") },
      { id: "backup_widget_removed", description: "Only backup widget was removed", pass: (doc) => !blockIds(doc).includes("booking_widget_backup") && blockIds(doc).includes("booking_widget") },
      { id: "record_links_preserved", description: "Both record links preserved", pass: (doc) => sameMultiset(itemLinkOnlyIds(doc), ["rec_arashiyama", "rec_map_pack"]) },
      { id: "inline_items_preserved", description: "Both inline items preserved separately", pass: (doc) => sameMultiset(inlineItemIds(doc), ["rec_primary_hotel", "rec_primary_hotel_backup"]) },
      { id: "inline_block_order", description: "Inline block order preserved", pass: (doc) => inlineBlockIds(doc).join(",") === "gallery_teaser,route_note,cta_signup,legal_note" },
      { id: "no_payload_json", description: "No block payload JSON leaked into prose", pass: (doc) => !text(doc).includes("_type") && !text(doc).includes("payload") },
    ],
  },
  {
    id: "campaign_reference_maze",
    title: "Update a long campaign page with many similar references",
    task: [
      "Change the title to \"Kyoto Campaign Refresh\".",
      "Move cta_primary so it appears immediately after the title.",
      "Keep cta_secondary near the end before the final reminder.",
      "Remove only feature_02 and feature_07.",
      "Do not remove feature_01, feature_03, feature_04, feature_05, or feature_06.",
      "Rewrite only the Day 3 paragraph so it says \"Day 3 now focuses on riverside shopping at Stop 3 with planning note ...\" while preserving rec_stop_03 and note_03.",
      "Keep every booking inline item from rec_booking_01 through rec_booking_07.",
      "Keep every tip inline block from tip_01 through tip_07.",
      "Do not rename numeric suffixes, collapse adjacent IDs, or output JSON.",
    ].join(" "),
    inputDoc: campaignDoc,
    oracleDoc: campaignOracleDoc(),
    checks: [
      { id: "title_updated", description: "Title changed to campaign refresh", pass: (doc) => text(doc).includes("Kyoto Campaign Refresh") },
      { id: "cta_primary_after_title", description: "cta_primary is immediately after the title", pass: (doc) => doc.document.children[1]?.type === "block" && doc.document.children[1]?.item === "cta_primary" },
      { id: "cta_secondary_near_end", description: "cta_secondary remains before final reminder", pass: (doc) => doc.document.children.at(-2)?.type === "block" && doc.document.children.at(-2)?.item === "cta_secondary" },
      { id: "removed_only_requested_features", description: "Only feature_02 and feature_07 were removed", pass: (doc) => sameMultiset(rootBlockOrder(doc), ["cta_primary", "feature_01", "feature_03", "feature_04", "feature_05", "feature_06", "cta_secondary"]) },
      { id: "day_three_rewritten", description: "Only Day 3 gets the requested rewrite", pass: (doc) => text(doc).includes("Day 3 now focuses on riverside shopping at") },
      { id: "day_three_reference_preserved", description: "Day 3 record link and note preserved", pass: (doc) => itemLinkOnlyIds(doc).includes("rec_stop_03") && inlineBlockIds(doc).includes("note_03") },
      { id: "all_booking_items_preserved", description: "All seven booking inline items preserved", pass: (doc) => sameMultiset(inlineItemIds(doc), ["rec_booking_01", "rec_booking_02", "rec_booking_03", "rec_booking_04", "rec_booking_05", "rec_booking_06", "rec_booking_07"]) },
      { id: "all_tips_preserved", description: "All seven tip inline blocks preserved", pass: (doc) => ["tip_01", "tip_02", "tip_03", "tip_04", "tip_05", "tip_06", "tip_07"].every((id) => inlineBlockIds(doc).includes(id)) },
      { id: "legal_and_brand_notes_preserved", description: "Final inline blocks preserved", pass: (doc) => inlineBlockIds(doc).includes("legal_note") && inlineBlockIds(doc).includes("brand_note") },
      { id: "no_payload_json", description: "No block payload JSON leaked into prose", pass: (doc) => !text(doc).includes("_type") && !text(doc).includes("payload") },
    ],
  },
];

function visit(node, fn) {
  if (!node || typeof node !== "object") return;
  fn(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) visit(child, fn);
  }
  if (node.document) visit(node.document, fn);
}

function text(doc) {
  const parts = [];
  visit(doc, (node) => {
    if (node.type === "span" && typeof node.value === "string") parts.push(node.value);
    if (node.type === "code" && typeof node.code === "string") parts.push(node.code);
  });
  return parts.join(" ");
}

function blockIds(doc) {
  const ids = [];
  visit(doc, (node) => {
    if (node.type === "block") ids.push(node.item);
  });
  return ids;
}

function rootBlockOrder(doc) {
  return doc.document.children
    .filter((node) => node.type === "block")
    .map((node) => node.item);
}

function inlineBlockIds(doc) {
  const ids = [];
  visit(doc, (node) => {
    if (node.type === "inlineBlock") ids.push(node.item);
  });
  return ids;
}

function itemLinkIds(doc) {
  const ids = [];
  visit(doc, (node) => {
    if (node.type === "itemLink" || node.type === "inlineItem") ids.push(node.item);
  });
  return ids;
}

function itemLinkOnlyIds(doc) {
  const ids = [];
  visit(doc, (node) => {
    if (node.type === "itemLink") ids.push(node.item);
  });
  return ids;
}

function inlineItemIds(doc) {
  const ids = [];
  visit(doc, (node) => {
    if (node.type === "inlineItem") ids.push(node.item);
  });
  return ids;
}

function sortedCopy(values) {
  return [...values].sort((left, right) => String(left).localeCompare(String(right)));
}

function sameMultiset(left, right) {
  return JSON.stringify(sortedCopy(left)) === JSON.stringify(sortedCopy(right));
}

function automaticReferenceChecks({ scenario, doc }) {
  return [
    {
      id: "expected_block_reference_set",
      description: "Block references match the expected document exactly",
      passed: sameMultiset(blockIds(doc), blockIds(scenario.oracleDoc)),
    },
    {
      id: "expected_inline_block_reference_set",
      description: "Inline block references match the expected document exactly",
      passed: sameMultiset(inlineBlockIds(doc), inlineBlockIds(scenario.oracleDoc)),
    },
    {
      id: "expected_record_link_reference_set",
      description: "Record links match the expected document exactly",
      passed: sameMultiset(itemLinkOnlyIds(doc), itemLinkOnlyIds(scenario.oracleDoc)),
    },
    {
      id: "expected_inline_item_reference_set",
      description: "Inline item references match the expected document exactly",
      passed: sameMultiset(inlineItemIds(doc), inlineItemIds(scenario.oracleDoc)),
    },
  ];
}

export function buildPrompt({ scenario, candidate }) {
  const source = candidate.serialize(scenario.inputDoc);
  return [
    "You are editing a structured_text field for a CMS record.",
    candidate.instructions,
    "The document may contain opaque CMS references. Never expand references into JSON or invent block fields.",
    "Return only the complete edited structured text document in the same format. Do not wrap it in Markdown fences or JSON.",
    "",
    `Task: ${scenario.task}`,
    "",
    "Current document:",
    source.trimEnd(),
  ].join("\n");
}

export function extractModelText(responseText) {
  const trimmed = responseText.trim();
  const fence = /^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/;
  const match = fence.exec(trimmed);
  return match ? match[1] : trimmed;
}

export function scoreOutput({ scenario, candidate, output }) {
  const source = extractModelText(output);
  try {
    const doc = candidate.parse(source);
    const scenarioChecks = scenario.checks.map((check) => ({
      id: check.id,
      description: check.description,
      passed: Boolean(check.pass(doc)),
    }));
    const sourceChecks = (candidate.sourceChecks ?? []).map((check) => ({
      id: check.id,
      description: check.description,
      passed: Boolean(check.pass(source)),
    }));
    const checks = [...sourceChecks, ...automaticReferenceChecks({ scenario, doc }), ...scenarioChecks];
    const passed = checks.filter((check) => check.passed).length;
    return {
      ok: passed === checks.length,
      parseOk: true,
      score: passed / checks.length,
      passed,
      total: checks.length,
      checks,
      source,
    };
  } catch (error) {
    return {
      ok: false,
      parseOk: false,
      score: 0,
      passed: 0,
      total: (candidate.sourceChecks?.length ?? 0) + 4 + scenario.checks.length,
      checks: [
        ...(candidate.sourceChecks ?? []).map((check) => ({ id: check.id, description: check.description, passed: false })),
        { id: "expected_block_reference_set", description: "Block references match the expected document exactly", passed: false },
        { id: "expected_inline_block_reference_set", description: "Inline block references match the expected document exactly", passed: false },
        { id: "expected_record_link_reference_set", description: "Record links match the expected document exactly", passed: false },
        { id: "expected_inline_item_reference_set", description: "Inline item references match the expected document exactly", passed: false },
        ...scenario.checks.map((check) => ({ id: check.id, description: check.description, passed: false })),
      ],
      source,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function callOpenAI(prompt, { model = DEFAULT_MODEL } = {}) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      temperature: 0,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
  }
  const body = await response.json();
  if (typeof body.output_text === "string") return body.output_text;
  const text = body.output?.flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .filter((value) => typeof value === "string")
    .join("\n");
  if (text) return text;
  throw new Error("OpenAI response did not contain output_text");
}

function parseArgValue(args, name, fallback = undefined) {
  const prefix = `${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

function runSubprocess(command, args, { input, timeoutMs = 120_000, cwd = tmpdir(), env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
    child.stdin.end(input);
  });
}

async function callCodex(prompt, { model = process.env.CODEX_MODEL ?? DEFAULT_MODEL } = {}) {
  if (!(await commandExists("codex"))) throw new Error("codex CLI not found");
  const outDir = await mkdtemp(join(tmpdir(), "agent-cms-codex-eval-"));
  const outPath = join(outDir, "last-message.txt");
  try {
    await runSubprocess("codex", [
      "exec",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--sandbox",
      "read-only",
      "--cd",
      tmpdir(),
      "--model",
      model,
      "--output-last-message",
      outPath,
      "-",
    ], { input: prompt, cwd: tmpdir(), timeoutMs: 180_000 });
    return await readFile(outPath, "utf8");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

async function callClaude(prompt, { model = process.env.CLAUDE_MODEL } = {}) {
  if (!(await commandExists("claude"))) throw new Error("claude CLI not found");
  const args = [
    "--print",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--output-format",
    "text",
  ];
  if (model) args.push("--model", model);
  args.push(prompt);
  return runSubprocess("claude", args, { input: "", cwd: tmpdir(), timeoutMs: 180_000 });
}

async function callProvider(provider, prompt, { model = DEFAULT_MODEL } = {}) {
  switch (provider) {
    case "dry":
      throw new Error("dry provider should not call a model");
    case "openai":
      return callOpenAI(prompt, { model });
    case "codex":
      return callCodex(prompt, { model });
    case "claude":
      return callClaude(prompt, { model });
    default:
      throw new Error(`Unknown provider '${provider}'`);
  }
}

export async function runEval({
  live = false,
  provider = live ? "openai" : "dry",
  model = DEFAULT_MODEL,
  formats = FORMAT_CANDIDATES,
  scenarioIds,
  repeat = 1,
} = {}) {
  const rows = [];
  const selectedScenarios = scenarioIds && scenarioIds.length > 0
    ? SCENARIOS.filter((scenario) => scenarioIds.includes(scenario.id))
    : SCENARIOS;
  for (let iteration = 0; iteration < repeat; iteration++) {
    for (const scenario of selectedScenarios) {
      for (const candidate of formats) {
        const prompt = buildPrompt({ scenario, candidate });
        const output = provider !== "dry"
          ? await callProvider(provider, prompt, { model })
          : candidate.serialize(scenario.oracleDoc);
        const score = scoreOutput({ scenario, candidate, output });
        rows.push({
          iteration,
          scenarioId: scenario.id,
          scenarioTitle: scenario.title,
          format: candidate.name,
          promptChars: prompt.length,
          outputChars: output.length,
          ...score,
        });
      }
    }
  }
  return rows;
}

function summarize(rows) {
  const byFormat = new Map();
  for (const row of rows) {
    const current = byFormat.get(row.format) ?? { format: row.format, runs: 0, score: 0, parseFailures: 0 };
    current.runs += 1;
    current.score += row.score;
    current.parseFailures += row.parseOk ? 0 : 1;
    byFormat.set(row.format, current);
  }
  return [...byFormat.values()].map((row) => ({
    ...row,
    averageScore: row.runs === 0 ? 0 : row.score / row.runs,
  }));
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const json = process.argv.includes("--json");
  const provider = parseArgValue(args, "--provider", live ? DEFAULT_PROVIDER === "dry" ? "openai" : DEFAULT_PROVIDER : DEFAULT_PROVIDER);
  const model = parseArgValue(args, "--model", DEFAULT_MODEL);
  const formatName = parseArgValue(args, "--format");
  const scenarioId = parseArgValue(args, "--scenario");
  const repeat = Number(parseArgValue(args, "--repeat", "1"));
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    throw new Error("--live requires OPENAI_API_KEY");
  }

  const formats = formatName
    ? FORMAT_CANDIDATES.filter((candidate) => candidate.name === formatName)
    : FORMAT_CANDIDATES;
  if (formatName && formats.length === 0) throw new Error(`Unknown format '${formatName}'`);
  const scenarioIds = scenarioId ? [scenarioId] : undefined;
  if (scenarioId && !SCENARIOS.some((scenario) => scenario.id === scenarioId)) {
    throw new Error(`Unknown scenario '${scenarioId}'`);
  }
  const rows = await runEval({ live: provider !== "dry", provider, model, formats, scenarioIds, repeat });
  const summary = summarize(rows);
  if (json) {
    console.log(JSON.stringify({ live: provider !== "dry", provider, model, summary, rows }, null, 2));
    return;
  }

  console.log(`Structured text agent eval (${provider === "dry" ? "dry run" : `${provider} ${model}`})`);
  for (const row of summary) {
    console.log(`${row.format.padEnd(14)} score=${row.averageScore.toFixed(2)} parseFailures=${row.parseFailures}/${row.runs}`);
  }
  console.log("");
  for (const row of rows) {
    console.log(`${row.scenarioId.padEnd(24)} ${row.format.padEnd(14)} score=${row.score.toFixed(2)} parse=${row.parseOk ? "ok" : "fail"}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
