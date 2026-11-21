import assert from "node:assert/strict";
import test from "node:test";
import { inspectMoment } from "../extension/analysis.js";
import { createProviders } from "../extension/providers.js";
import { parseGeminiKeyFile } from "../extension/key-settings.js";
import { distinctTopics, normalizeSections } from "../extension/suggestions.js";

const moment = {
  screenshot: "data:image/jpeg;base64,YQ==",
  clip: { video: "data:video/webm;base64,Yg==", durationMs: 9880 },
  title: "Gear review",
  url: "https://example.com/review",
};

test("Hydrogen gets only the playable video as context and prioritizes its ending", async () => {
  const providers = createProviders({ apiKey: "test-key", fetcher: async (url, options) => {
    const request = JSON.parse(options.body);
    assert.match(url, /\/interactions$/);
    assert.equal(options.priority, "low");
    assert.equal(request.model, "gemini-4-hydrogen");
    assert.equal(request.store, false);
    assert.equal(request.generation_config.thinking_level, "low");
    assert.deepEqual(request.input, [
      { type: "video", mime_type: "video/webm", data: "Yg==", processing: { type: "static", fps: 2 } },
      { type: "text", text: "Generate the sidebar for this moment." },
    ]);
    assert.match(request.system_instruction, /final two seconds as the strongest signal/);
    const chip = request.response_format.schema.properties.sections.items.properties.chips.items;
    assert.deepEqual(Object.keys(chip.properties), ["label", "question"]);
    const lookup = request.response_format.schema.properties.webQueries.items;
    assert.deepEqual(lookup.properties.kind.enum, ["answer", "video", "visit", "order", "page", "paper", "person"]);
    assert.equal(request.response_format.schema.properties.webQueries.maxItems, 5);
    assert.ok(lookup.required.includes("evidence"));
    return Response.json({ steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify({ sections: [], webQueries: [], product: null }) }],
    }] });
  } });
  assert.deepEqual(await providers.analyze(moment, new AbortController().signal), {
    sections: [], webQueries: [], product: null,
  });
});

test("the quick request uses video and preserves the model's choice of sections", async () => {
  const chip = { label: "Hydrostatic head", question: "What does hydrostatic head say about this fabric?" };
  const sections = [{ title: "Fabric specs", chips: [chip] }];
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(options.priority, "high");
    assert.equal(request.model, "gemini-3.5-flash-lite");
    assert.equal(request.generation_config.thinking_level, "minimal");
    assert.deepEqual(request.input.map((item) => item.type), ["video", "text"]);
    assert.deepEqual(request.input[0].processing, { type: "static", fps: 1 });
    assert.match(request.system_instruction, /final two seconds as the strongest signal/);
    const properties = request.response_format.schema.properties;
    assert.deepEqual(Object.keys(properties), ["sections"]);
    assert.equal(properties.sections.maxItems, 2);
    assert.deepEqual(Object.keys(properties.sections.items.properties.chips.items.properties), ["label", "question"]);
    return Response.json({ steps: [{ type: "model_output", content: [{
      type: "text", text: JSON.stringify({ sections }),
    }] }] });
  } });
  assert.deepEqual(await providers.quickChips(moment, new AbortController().signal), sections);
});

test("chip answers send the question and the same video context", async () => {
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.input.map((item) => item.type), ["video", "text"]);
    assert.equal(request.input[0].data, "Yg==");
    assert.match(request.input[1].text, /What does this rating mean\?/);
    assert.doesNotMatch(request.input[1].text, /Gear review|example\.com/);
    return Response.json({ output_text: "It describes the fabric’s water resistance." });
  } });
  const answer = await providers.followUp(moment, "What does this rating mean?", [], new AbortController().signal);
  assert.equal(answer, "It describes the fabric’s water resistance.");
});

test("lookup sections and chip labels come from the model and gated searches route separately", async () => {
  const sections = [{ title: "Fabric specs", chips: [{ label: "Water column", question: "How is this rating measured?" }] }];
  const product = { title: "Shop similar shells", label: "Packable rain jackets", query: "packable rain jacket" };
  const webQueries = [
    { title: "What reviewers say", label: "Trail performance", query: "named shell independent reviews", kind: "answer", evidence: "The shell is reviewed." },
    { title: "See the test", label: "Watch a spray test", query: "waterproof shell spray test tutorial YouTube", kind: "video", evidence: "The clip mentions a spray test." },
    { title: "Compare prices", label: "Other stores", query: "named shell exact variant prices", kind: "answer", evidence: "The exact model is visible." },
  ];
  const calls = [];
  const events = [];
  const providers = {
    analyze: async () => ({ summary: "Rain shell review", sections, product, webQueries }),
    decide: async () => ({ shop: 0.9, web_0: 0.9, web_1: 0.2, web_2: 0.8 }),
    shop: async (candidate) => {
      calls.push(candidate.query);
      return { items: [], warnings: [] };
    },
    search: async (candidate) => {
      calls.push(candidate.query);
      return { blocks: [], suggestions: [] };
    },
  };
  const send = (type, payload) => events.push({ type, ...payload });
  const signal = new AbortController().signal;
  await inspectMoment(providers, moment, signal, send);
  assert.deepEqual(events[0], { type: "context", sections });
  assert.deepEqual(events[1], {
    type: "lookup",
    links: [
      { id: "catalog", title: product.title, label: product.label, kind: "shop" },
      ...[0, 2].map((index) => ({
        id: "web_" + index, title: webQueries[index].title, label: webQueries[index].label, kind: webQueries[index].kind,
      })),
    ],
  });
  assert.deepEqual(calls, [product.query, webQueries[0].query, webQueries[2].query]);
  assert.deepEqual(events.filter(({ id }) => id).map(({ id }) => id), ["catalog", "web_0", "web_2"]);

  calls.length = 0;
  const blocked = { ...providers, decide: async () => ({ shop: 0.2, web_0: 0.1 }) };
  await inspectMoment(blocked, moment, signal, send);
  assert.deepEqual(calls, []);
});

test("vague labels and repeated questions are filtered across sections", () => {
  const rating = { label: "10,000 mm rating", question: "What rain protection does this rating indicate?" };
  const jacket = { label: "Self-stowing pocket", question: "Where does the rain shell pack away?" };
  assert.deepEqual(normalizeSections([
    { title: "What’s visible", chips: [
      { label: "Video summary", question: "What happened?" },
      rating,
      { label: "10000 mm rating", question: "How is the rating measured?" },
    ] },
    { title: "Gear shown earlier", chips: [
      { label: "Waterproof score", question: "What rain protection does this rating indicate" },
      jacket,
    ] },
  ], 4), [
    { title: "What’s visible", chips: [rating] },
    { title: "Gear shown earlier", chips: [jacket] },
  ]);
});

test("the final panel keeps an opened topic and prefers distinct suggestions", async () => {
  const rating = { label: "Waterproof rating", question: "What does this waterproof rating tell the viewer?" };
  const alias = { label: "Hydrostatic head", question: "How much water pressure can this fabric resist?" };
  const method = { label: "Water column test", question: "How is this waterproof rating tested?" };
  const jacket = { label: "Self-stowing pocket", question: "Where does this rain shell pack away?" };
  const providers = createProviders({ apiKey: "test-key", fetcher: async (url, options) => {
    const request = JSON.parse(options.body);
    assert.match(url, /\/decisions$/);
    assert.equal(Object.keys(request.questions).length, 6);
    assert.match(request.input, /"index":1,"label":"Hydrostatic head"/);
    return Response.json({ answers: {
      same_0_1: { noul: 0.96 }, same_0_2: { noul: 0.91 }, same_1_2: { noul: 0.86 }, same_0_3: { noul: 0.08 },
    } });
  } });
  const matches = await providers.sameTopics([rating, alias, method, jacket], new AbortController().signal);
  const sections = [{ title: "Clip details", chips: [alias, method, jacket] }];
  assert.deepEqual(distinctTopics(sections, 1, [0], matches), [{ title: "Clip details", chips: [jacket] }]);
  assert.deepEqual(distinctTopics(sections, 1, [], matches), [{ title: "Clip details", chips: [alias, jacket] }]);
});

test("Decision 1 and Neon use separate operations, with grounded sources preserved", async () => {
  const providers = createProviders({ apiKey: "test-key", fetcher: async (url, options) => {
    const request = JSON.parse(options.body);
    if (url.endsWith("/decisions")) {
      assert.equal(request.model, "gemini-decision-1");
      assert.deepEqual(Object.keys(request.questions), ["shop", "web_0", "web_1"]);
      assert.match(request.questions.web_1.instructions, /only lookup web_1/);
      assert.match(request.questions.web_1.instructions, /recipe.*featured dish/);
      return Response.json({ answers: { shop: { noul: 0.9 }, web_0: { noul: 0.8 }, web_1: { noul: 0.1 } } });
    }
    assert.equal(request.model, "gemini-4-neon");
    assert.deepEqual(request.tools, [{ type: "google_search" }]);
    assert.doesNotMatch(request.input, /private context/);
    return Response.json({
      steps: [
        { type: "google_search_result", result: [{ search_suggestions: "<style></style>" }] },
        { type: "model_output", content: [{
          type: "text", text: "Available in blue.",
          annotations: [{ type: "url_citation", url: "https://example.com/item", title: "Item", start_index: 0, end_index: 18 }],
        }] },
      ],
    });
  } });
  const signal = new AbortController().signal;
  assert.deepEqual(await providers.decide({
    product: { label: "Jacket" }, webQueries: [{ id: "web_0", kind: "answer" }, { id: "web_1", kind: "page" }],
  }, signal), { shop: 0.9, web_0: 0.8, web_1: 0.1 });
  const result = await providers.search({ query: "Jacket", kind: "answer", evidence: "private context" }, signal);
  assert.equal(result.searched, true);
  assert.equal(result.blocks[0].citations[0].url, "https://example.com/item");
  assert.deepEqual(result.suggestions, ["<style></style>"]);
});

test("Neon action results use citation URLs for specific destinations, including Unicode titles", async () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/grounded-video";
  const direct = "https://www.youtube.com/watch?v=spUNpyF58BY";
  const titles = ["No source", "FFT — a visual guide", "FFT | Worked example", "Search results", "Unsafe URL"];
  const lines = titles.map((title) => title + " | One useful step.");
  const urls = ["", redirect, direct, "https://www.youtube.com/results?search_query=fft", "javascript:alert(1)"];
  let offset = 0;
  const annotations = lines.flatMap((line, i) => {
    const start = offset;
    offset += Buffer.byteLength(line) + 1;
    return urls[i] ? [{
      type: "url_citation", title: "youtube.com", url: urls[i], start_index: start, end_index: offset - 1,
    }] : [];
  });
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, "gemini-4-neon");
    assert.match(request.system_instruction, /individual YouTube video/);
    return Response.json({ steps: [
      { type: "google_search_result", result: [{ search_suggestions: "<div>FFT</div>" }] },
      { type: "model_output", content: [{ type: "text", text: lines.join("\n"), annotations }] },
    ] });
  } });
  const result = await providers.search({ kind: "video", query: "visual FFT tutorial" }, new AbortController().signal);
  assert.deepEqual(result, {
    destinations: [
      { title: titles[1], reason: "One useful step.", url: redirect, site: "youtube.com" },
      { title: titles[2], reason: "One useful step.", url: direct, site: "youtube.com" },
    ],
    suggestions: ["<div>FFT</div>"],
  });
});

test("without a valid grounding citation, prose and generic URLs cannot become action links", async () => {
  const text = "Unrelated homepage | Looks plausible.";
  const providers = createProviders({ apiKey: "test-key", fetcher: async () => Response.json({ steps: [
    { type: "google_search_result", result: [] },
    { type: "model_output", content: [{
      type: "text", text,
      annotations: [{ type: "url_citation", title: "example.com", url: "https://example.com/", start_index: 0, end_index: text.length }],
    }] },
    { type: "model_output", content: [{ type: "text", text: "Invented | https://example.org/tour" }] },
  ] }) });
  assert.deepEqual(await providers.search({ kind: "visit", query: "test tour" }, new AbortController().signal), {
    destinations: [], suggestions: [],
  });
});

test("academic references use a cited DOI and a Wikipedia article for each person", async () => {
  const citations = {
    paper: ["The Monte Carlo Method", "https://doi.org/10.1080/01621459.1949.10483310"],
    person: ["Stanisław Ulam", "https://en.wikipedia.org/wiki/Stanis%C5%82aw_Ulam"],
  };
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    const person = request.system_instruction.includes("Wikipedia biography");
    const [title, url] = citations[person ? "person" : "paper"];
    const line = title + " | Matches the reference in the clip.";
    const paths = person ? [
      "https://en.wikipedia.org/w/index.php?search=Ulam",
      "https://en.wikipedia.org/wiki/Ulam_(disambiguation)",
      "https://example.com/people/Ulam",
      url,
    ] : [url];
    if (!person) assert.match(request.system_instruction, /exact research paper/);
    return Response.json({ steps: [
      { type: "google_search_result", result: [] },
      { type: "model_output", content: [{
        type: "text", text: line, annotations: paths.map((path) => ({
          type: "url_citation", title: new URL(path).hostname, url: path,
          start_index: 0, end_index: Buffer.byteLength(line),
        })),
      }] },
    ] });
  } });
  for (const [kind, [title, url]] of Object.entries(citations)) {
    const result = await providers.search({ kind, query: title }, new AbortController().signal);
    assert.deepEqual(result.destinations.map((item) => item.url), [url]);
  }
});

test("Shopify Global Catalog MCP preserves the variant link and applies an explicit budget", async () => {
  const url = "https://example.com/products/jacket?variant=42&campaign=shop";
  const providers = createProviders({ fetcher: async (endpoint, options) => {
    assert.equal(endpoint, "https://catalog.shopify.com/api/ucp/mcp");
    const { params } = JSON.parse(options.body);
    assert.equal(params.name, "search_catalog");
    assert.match(params.arguments.meta["ucp-agent"].profile, /^https:\/\/shopify\.dev\//);
    assert.equal(params.arguments.catalog.filters.price.max, 10_000);
    return Response.json({ result: { structuredContent: {
      products: [{
        title: "Packable jacket",
        variants: [{ url, price: { amount: 6400, currency: "USD" }, seller: { name: "Merchant" } }],
      }],
      messages: [{ type: "warning", content: "Some availability varies." }],
    } } });
  } });
  const result = await providers.shop({ query: "packable rain jacket", maxUsd: 100 }, new AbortController().signal);
  assert.deepEqual(result, {
    warnings: ["Some availability varies."],
    items: [{ title: "Packable jacket", price: "$64.00", merchant: "Merchant", image: null, url }],
  });
});

test("key import reads GEMINI_API_KEY from the chosen env file", () => {
  assert.equal(parseGeminiKeyFile("PRIVATE_OTHER=secret\r\nexport GEMINI_API_KEY = 'example-gemini-key' # note\r\n"), "example-gemini-key");
  assert.equal(parseGeminiKeyFile("GEMINI_API_KEY=old\nGEMINI_API_KEY=new # use latest"), "new");
  assert.equal(parseGeminiKeyFile("OTHER_GEMINI_API_KEY=unrelated\n# GEMINI_API_KEY=comment"), "");
});

test("Gemini credentials are scoped to the API header and redacted from errors", async () => {
  const key = "example-gemini-key";
  const providers = createProviders({ apiKey: key, fetcher: async (url, options) => {
    assert.equal(new URL(url).hostname, "generativelanguage.googleapis.com");
    assert.equal(options.headers["x-goog-api-key"], key);
    assert.equal(options.body.includes(key), false);
    return Response.json({ error: { message: "Invalid " + key } }, { status: 400 });
  } });
  await assert.rejects(providers.analyze(moment, new AbortController().signal), /Invalid \[redacted\]/);
});
