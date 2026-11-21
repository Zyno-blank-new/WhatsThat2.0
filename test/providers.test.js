import assert from "node:assert/strict";
import test from "node:test";
import { answerMoment, inspectMoment } from "../extension/analysis.js";
import { landmarkPhoto, siteIcon, youtubeThumbnail, youtubeVideoId } from "../extension/card-images.js";
import { createProviders } from "../extension/providers.js";
import { amazonItemUrl, productPhotoKey } from "../extension/products.js";
import { parseGeminiKeyFile } from "../extension/key-settings.js";
import { distinctTopics, normalizeSections } from "../extension/suggestions.js";

const moment = {
  screenshot: "data:image/jpeg;base64,YQ==",
  clip: { video: "data:video/webm;base64,Yg==", previewVideo: "data:video/webm;base64,Yw==", durationMs: 9880 },
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
    assert.deepEqual(Object.keys(chip.properties), ["label", "question", "answer", "sourceQuery"]);
    const lookup = request.response_format.schema.properties.webQueries.items;
    assert.deepEqual(lookup.properties.kind.enum, ["answer", "video", "visit", "order", "page", "paper", "person"]);
    assert.equal(request.response_format.schema.properties.webQueries.maxItems, 5);
    assert.ok(lookup.required.includes("evidence"));
    return Response.json({ steps: [{
      type: "model_output",
      content: [{ type: "text", text: JSON.stringify({ sections: [], webQueries: [], products: [] }) }],
    }] });
  } });
  assert.deepEqual(await providers.analyze(moment, new AbortController().signal), {
    sections: [], webQueries: [], products: [],
  });
});

test("the quick request returns section names, instant answers, and placeholders", async () => {
  const chip = { label: "Hydrostatic head", question: "What does hydrostatic head say about this fabric?",
    answer: "It measures the water pressure the fabric can resist." };
  const sections = [{ title: "Fabric specs", layout: "chips", chips: [chip] },
    { title: "Waterproofing demonstration", layout: "video", chips: [] }];
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(options.priority, "high");
    assert.equal(request.model, "gemini-3.5-flash-lite");
    assert.equal(request.generation_config.thinking_level, "minimal");
    assert.deepEqual(request.input.map((item) => item.type), ["video", "text"]);
    assert.deepEqual(request.input[0].processing, { type: "static", fps: 1 });
    assert.equal(request.input[0].data, moment.clip.previewVideo.split(",")[1]);
    assert.match(request.system_instruction, /greatest weight to the last two seconds/);
    const properties = request.response_format.schema.properties;
    assert.deepEqual(Object.keys(properties), ["focus", "sections", "products", "webQueries"]);
    assert.ok(properties.focus.required.includes("ingredient"));
    assert.equal(properties.products.maxItems, 2);
    assert.ok(properties.products.items.required.includes("description"));
    assert.match(request.system_instruction, /things people wear, use, or demonstrate/);
    assert.equal(properties.sections.maxItems, 4);
    assert.equal(properties.webQueries.maxItems, 1);
    assert.deepEqual(Object.keys(properties.sections.items.properties.chips.items.properties), ["label", "question", "answer", "sourceQuery"]);
    return Response.json({ steps: [{ type: "model_output", content: [{
      type: "text", text: JSON.stringify({ sections, webQueries: [] }),
    }] }] });
  } });
  assert.deepEqual(await providers.quickPlan(moment, new AbortController().signal), { sections, products: [], webQueries: [] });
});

test("an early search starts before video analysis and is reused by the final plan", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const reference = { title: "People", layout: "link", chips: [] };
  const lookup = { title: "People", kind: "person", subject: "Stanisław Ulam", label: "Ulam biography",
    query: "Stanisław Ulam mathematician Wikipedia", evidence: "The video names Ulam." };
  const events = [];
  const calls = [];
  const providers = {
    quickPlan: async () => ({ sections: [reference], webQueries: [lookup] }),
    analyze: () => promise,
    decide: async ({ webQueries }) => Object.fromEntries(webQueries.map(({ id }) => [id, 0.9])),
    search: async ({ id }) => {
      calls.push(id);
      resolve({ sections: [], products: [], webQueries: [{ ...lookup, subject: "Stanislaw Ulam" }] });
      return { destinations: [{ title: "Stanisław Ulam", url: "https://en.wikipedia.org/wiki/Stanis%C5%82aw_Ulam" }], suggestions: [] };
    },
  };
  await inspectMoment(providers, moment, AbortSignal.timeout(1000), (type, value) => events.push({ type, ...value }));
  assert.deepEqual(calls, ["preview_0"]);
  assert.deepEqual(events[0], { type: "preview", sections: [reference] });
  assert.equal(events[1].preview, true);
  assert(events.findIndex(({ type }) => type === "lookup") < events.findIndex(({ type }) => type === "context"));
  assert.equal(events.filter(({ type }) => type === "web").length, 1);
});

test("distinct foreground hats reach the catalog before full analysis and matching results are reused", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const products = [
    { name: "Woven straw sun hat", description: "wide brim and chin cord", evidence: "A person wears it in front.", exact: false },
    { name: "Safari fedora", description: "tan crown with a dark band", evidence: "Another person wears it in front.", exact: false },
  ];
  const calls = [];
  const events = [];
  const providers = {
    quickPlan: async () => ({ sections: [], products, webQueries: [] }),
    analyze: () => promise,
    decide: async ({ products }) => Object.fromEntries(products.map(({ id }) => [id, 0.9])),
    merchantListings: async () => ({ items: [] }),
    verifyProducts: async (_product, items) => items,
    shop: async ({ name, description, id }) => {
      calls.push({ name, description, id });
      if (calls.length === 2) resolve({
        sections: [], products: [products[1], { ...products[0], name: "Woven straw hat" }], webQueries: [],
      });
      return { items: [{ title: name, url: "https://example.com/products/" + id }] };
    },
  };
  await inspectMoment(providers, moment, AbortSignal.timeout(1000), (type, value) => events.push({ type, ...value }));
  assert.deepEqual(calls, products.map(({ name, description }, index) => ({ name, description, id: "preview_catalog_" + index })));
  assert.deepEqual(events.filter(({ type, preview }) => type === "lookup" && preview).map(({ links }) => links[0].name),
    products.map(({ name }) => name));
  assert.equal(events.filter(({ type, items }) => type === "shop" && items.length).length, 2);
});

test("a full-analysis product can retry an early search with a more specific description", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const product = { name: "Straw sun hat", description: "wide brim", evidence: "Worn by the speaker.", exact: false };
  const calls = [];
  const providers = {
    quickPlan: async () => ({ sections: [], products: [product], webQueries: [] }),
    analyze: () => promise,
    decide: async ({ products: [candidate] }) => ({ [candidate.id]: 0.9 }),
    merchantListings: async () => ({ items: [] }),
    verifyProducts: async (_product, items) => items,
    shop: async ({ description, id }) => {
      calls.push(description);
      if (id === "preview_catalog_0") {
        resolve({ sections: [], products: [{ ...product, description: "adjustable chin cord" }], webQueries: [] });
        return { items: [] };
      }
      return { items: [{ title: product.name, url: "https://example.com/products/straw-sun-hat" }] };
    },
  };
  const events = [];
  await inspectMoment(providers, moment, AbortSignal.timeout(1000), (type, value) => events.push({ type, ...value }));
  assert.deepEqual(calls, ["wide brim", "adjustable chin cord"]);
  assert.equal(events.find(({ type, items }) => type === "shop" && items.length).id, "catalog_0");
});

test("both shopping sources publish only verified items without waiting for the slower source", async () => {
  const product = { name: "Straw sun hat", description: "wide brim", evidence: "Worn by the speaker." };
  const catalogHat = { title: "Wide-brim straw sun hat", url: "https://example.com/products/hat" };
  const toy = { title: "Speaker's branded toy", url: "https://example.com/products/toy" };
  const webHat = { title: "Woven straw sun hat", url: "https://elsewhere.example/products/hat" };
  const { promise, resolve } = Promise.withResolvers();
  const events = [];
  const providers = {
    analyze: async () => ({ sections: [], products: [product], webQueries: [] }),
    decide: async () => ({ catalog_0: 0.9 }),
    shop: async () => ({ items: [catalogHat, toy] }),
    merchantListings: () => promise,
    verifyProducts: async (_target, items) => items.filter((item) => item !== toy),
  };
  await inspectMoment(providers, moment, new AbortController().signal, (type, value) => {
    events.push({ type, ...value });
    if (value?.source === "shop") resolve({ items: [webHat] });
  });
  assert.deepEqual(events.filter(({ source }) => source).map(({ source, items }) => [source, items]), [
    ["shop", [catalogHat]], ["merchantListings", [webHat]],
  ]);
  assert.equal(events.at(-2).complete, true);
});

test("a dish starts recipe and ingredient searches during routing and skips presenter links", async () => {
  const full = Promise.withResolvers();
  const decision = Promise.withResolvers();
  const focus = { kind: "dish", title: "Pan-seared steak", detail: "A seared steak is sliced beside potatoes.",
    ingredient: "Ribeye steak", tip: "Pat the steak dry before searing for a better crust." };
  const person = { kind: "person", title: "Creators", label: "Presenter", subject: "Presenter Name",
    query: "Presenter Name", evidence: "They introduce the video." };
  const events = [];
  const started = [];
  const record = (name) => {
    started.push(name);
    if (started.length === 3) {
      assert.equal(events.filter(({ type }) => type === "shop" || type === "web").length, 0);
      decision.resolve({ preview_ingredient: 0.1, preview_recipe: 1 });
    }
  };
  const providers = {
    quickPlan: async () => ({ focus, sections: [], webQueries: [person] }),
    analyze: () => full.promise,
    decide: async ({ products, webQueries }) => {
      if (!products.length) return {};
      assert.equal(products[0].name, "Ribeye steak");
      assert.equal(products[0].ingredient, true);
      assert.deepEqual(webQueries.map(({ kind }) => kind), ["recipe"]);
      return decision.promise;
    },
    search: async ({ kind, query }) => {
      record(kind);
      assert.match(query, /Pan-seared steak.*recipe/);
      return { destinations: [{ url: "https://recipes.example/pan-seared-steak" }] };
    },
    shop: async () => { record("shop"); return { items: [{ title: "Ribeye steak" }] }; },
    merchantListings: async () => { record("merchantListings"); return { items: [] }; },
    verifyProducts: async () => assert.fail("Rejected ingredient must never be presented"),
  };
  await inspectMoment(providers, moment, AbortSignal.timeout(1000), (type, value) => {
    events.push({ type, ...value });
    if (type === "web") full.resolve({ sections: [], webQueries: [], products: [] });
  });
  assert.deepEqual(started.sort(), ["merchantListings", "recipe", "shop"]);
  assert.equal(events[0].focus.tip, focus.tip);
  assert.ok(events.some(({ type, id }) => type === "warning" && id === "preview_ingredient"));
  assert.ok(events.every(({ type }) => type !== "shop"));
});

test("a landmark visit adds a related video search and a product detail page adds independent reviews", async () => {
  const place = {
    title: "Visit", label: "Book tickets", kind: "visit", query: "Giza Plateau official tickets",
    subject: "Giza Plateau", evidence: "The clip shows the named site.",
  };
  const product = {
    name: "Sony WH-1000XM5", description: "over-ear headphones", exact: true, productPage: true, evidence: "The model and the Add to cart button are visible.",
  };
  const candidates = [];
  const links = [];
  const providers = {
    analyze: async () => ({ sections: [], products: [product], webQueries: [place] }),
    decide: async ({ webQueries }) => Object.fromEntries(webQueries.map(({ id }) => [id, 1])),
    search: async (candidate) => {
      candidates.push(candidate);
      return { destinations: [] };
    },
  };
  await inspectMoment(providers, { ...moment, videoId: "ABCDEFGHIJK" }, new AbortController().signal, (type, value) => {
    if (type === "lookup") links.push(...value.links);
  });
  assert.deepEqual(candidates.map(({ kind }) => kind), ["review", "visit", "video"]);
  assert.match(candidates[0].query, /Sony WH-1000XM5 .*reviews/);
  assert.equal(candidates[2].subject, "Giza Plateau");
  assert.equal(candidates[2].excludeVideoId, "ABCDEFGHIJK");
  assert.equal(links.find(({ kind }) => kind === "visit").subject, "Giza Plateau");
});

test("alternate model spelling does not start a second review or shopping search", async () => {
  const { promise, resolve } = Promise.withResolvers();
  const primary = {
    name: "Sony WH-1000XM5 Noise Canceling Headphones", exact: true, productPage: true,
    evidence: "The model and add-to-cart button are visible.",
  };
  const calls = [];
  const providers = {
    quickPlan: async () => ({ sections: [], products: [primary], webQueries: [] }),
    analyze: () => promise,
    decide: async ({ products, webQueries }) => Object.fromEntries([...products, ...webQueries].map(({ id }) => [id, 1])),
    search: async ({ id }) => {
      calls.push(id);
      resolve({ sections: [], products: [{ ...primary, name: "Sony WH1000XM5 Wireless Headphones" }], webQueries: [] });
      return { destinations: [{ url: "https://reviews.example/sony-xm5" }] };
    },
    shop: async ({ id }) => {
      calls.push(id);
      return { items: [{ title: primary.name, url: "https://shop.example/products/sony-xm5" }] };
    },
    merchantListings: async () => ({ items: [] }),
    verifyProducts: async (_product, items) => items,
  };
  await inspectMoment(providers, moment, new AbortController().signal, () => {});
  assert.deepEqual(calls.sort(), ["preview_catalog_0", "preview_reviews"]);
});

test("chip answers use the video to give explanations and can request public verification", async () => {
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.input.map((item) => item.type), ["video", "text"]);
    assert.equal(request.input[0].data, "Yg==");
    assert.match(request.input[1].text, /What does this rating mean\?/);
    assert.doesNotMatch(request.input[1].text, /Gear review|example\.com/);
    assert.match(request.system_instruction, /add established background/);
    assert.deepEqual(request.response_format.schema.required, ["answer", "searchQuery"]);
    return Response.json({ output_text: JSON.stringify({
      answer: "It describes the fabric’s water resistance.", searchQuery: null,
    }) });
  } });
  const answer = await providers.followUp(moment, "What does this rating mean?", [], new AbortController().signal);
  assert.deepEqual(answer, { answer: "It describes the fabric’s water resistance.", searchQuery: "" });
});

test("a named organization can get a cited answer without sending the video to Search", async () => {
  const question = "What is JSAP and why might presenting there have mattered?";
  const answer = "JSAP is a scientific society that provides a venue for presenting applied physics research.";
  const query = "What role did the Japan Society of Applied Physics have in early EUV lithography research?";
  const cited = { text: "The Japan Society of Applied Physics publishes applied physics research.",
    citations: [{ url: "https://www.jsap.or.jp/english/", title: "Japan Society of Applied Physics" }] };
  const signal = new AbortController().signal;
  const calls = [];
  const providers = {
    followUp: async (captured, asked) => {
      assert.equal(captured, moment);
      assert.equal(asked, question);
      return { answer, searchQuery: query };
    },
    search: async (lookup) => {
      calls.push(lookup);
      return { searched: true, blocks: [cited], suggestions: ["<div>search</div>"] };
    },
  };
  const preview = (draft) => calls.push(draft.blocks[0].text);
  const result = await answerMoment(providers, moment, question, [], signal, preview);
  assert.deepEqual(calls, [answer, { kind: "answer", query }]);
  assert.deepEqual(result, { answer, searched: true, blocks: [cited], suggestions: ["<div>search</div>"] });

  providers.search = async () => ({ searched: true, blocks: [{ text: "Uncited rewrite", citations: [] }], suggestions: [] });
  const fallback = await answerMoment(providers, moment, question, [], signal, preview);
  assert.deepEqual(fallback.blocks, [{ text: answer, citations: [] }]);
});

test("lookup sections and chip labels come from the model and gated searches route separately", async () => {
  const sections = [{ title: "Fabric specs", chips: [{ label: "Water column", question: "How is this rating measured?" }] }];
  const visual = { seconds: 1, box: [100, 100, 500, 600] };
  const product = { name: "named packable rain jacket", description: "Blue shell", evidence: "The model name is visible.", exact: true, visual };
  const webQueries = [
    { title: "What reviewers say", label: "Trail performance", query: "named shell independent reviews", kind: "answer", evidence: "The shell is reviewed." },
    { title: "See the test", label: "Watch a spray test", query: "waterproof shell spray test tutorial YouTube", kind: "video", evidence: "The clip mentions a spray test." },
    { title: "Compare prices", label: "Other stores", query: "named shell exact variant prices", kind: "answer", evidence: "The exact model is visible." },
  ];
  const calls = [];
  const events = [];
  const providers = {
    analyze: async () => ({ summary: "Rain shell review", sections, products: [product], webQueries }),
    decide: async () => ({ catalog_0: 0.9, web_0: 0.9, web_1: 0.2, web_2: 0.8 }),
    shop: async (candidate) => {
      calls.push(candidate.name);
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
      { id: "catalog_0", kind: "shop", name: product.name, exact: true },
      ...[0, 2].map((index) => ({
        id: "web_" + index, title: webQueries[index].title, label: webQueries[index].label, kind: webQueries[index].kind,
      })),
    ],
  });
  assert.deepEqual(calls, [product.name, webQueries[0].query, webQueries[2].query]);
  assert.deepEqual(events.filter(({ id }) => id).map(({ id }) => id).sort(), ["catalog_0", "web_0", "web_2"]);

  calls.length = 0;
  const blocked = { ...providers, decide: async () => ({ catalog_0: 0.2, web_0: 0.1 }) };
  await inspectMoment(blocked, moment, signal, send);
  assert.deepEqual(calls, []);

  const generic = { ...providers, analyze: async () => ({
    sections, webQueries: [], products: [{ ...product, exact: false }],
  }) };
  await inspectMoment(generic, moment, signal, send);
  assert.deepEqual(calls, [product.name]);

  const amazonItem = "https://www.amazon.com/dp/B0CFPJYX7P";
  events.length = 0;
  await inspectMoment(providers, { ...moment, amazonItem }, signal, send);
  assert.deepEqual(events.find(({ id }) => id === "amazon-item"), {
    type: "shop", id: "amazon-item", visual, complete: true,
    items: [{ title: product.name, url: amazonItem, merchant: "amazon.com" }],
  });
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
      assert.deepEqual(Object.keys(request.questions), ["catalog_0", "web_0", "web_1"]);
      assert.match(request.questions.catalog_0.instructions, /worn, carried, or used in the foreground/);
      assert.match(request.questions.web_1.instructions, /only lookup web_1/);
      assert.match(request.questions.web_1.instructions, /recipe.*featured dish/);
      return Response.json({ answers: { catalog_0: { noul: 0.9 }, web_0: { noul: 0.8 }, web_1: { noul: 0.1 } } });
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
    products: [{ id: "catalog_0", name: "Jacket" }], webQueries: [{ id: "web_0", kind: "answer" }, { id: "web_1", kind: "page" }],
  }, signal), { catalog_0: 0.9, web_0: 0.8, web_1: 0.1 });
  const result = await providers.search({ query: "Jacket", kind: "answer", evidence: "private context" }, signal);
  assert.equal(result.searched, true);
  assert.equal(result.blocks[0].citations[0].url, "https://example.com/item");
  assert.deepEqual(result.suggestions, ["<style></style>"]);
});

test("Neon action results use citation URLs for specific destinations, including Unicode titles", async () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/grounded-video";
  const direct = "https://www.youtube.com/watch?v=spUNpyF58BY";
  const titles = ["No source", "FFT — a visual guide", "FFT | Worked example", "Search results", "Unsafe URL"];
  const lines = titles.map((title, index) => title + " | One useful step." +
    (index === 1 ? " | https://www.youtube.com/watch?v=Q-YNk18TA2M" : ""));
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
      { title: titles[1], reason: "One useful step.", url: redirect, site: "youtube.com", videoUrl: "https://www.youtube.com/watch?v=Q-YNk18TA2M" },
      { title: titles[2], reason: "One useful step.", url: direct, site: "youtube.com" },
    ],
    suggestions: ["<div>FFT</div>"],
  });
});

test("card artwork is scoped to the exact video or a public site icon", () => {
  const id = "spUNpyF58BY";
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=" + id), id);
  assert.equal(youtubeVideoId("https://youtube.com/shorts/" + id), id);
  assert.equal(youtubeVideoId("https://youtu.be/" + id), id);
  assert.equal(youtubeVideoId("https://www.youtube.com/results?v=" + id), null);
  assert.equal(youtubeVideoId("https://youtube.com.invalid/watch?v=" + id), null);
  assert.equal(youtubeThumbnail(id), "https://i.ytimg.com/vi/spUNpyF58BY/mqdefault.jpg");
  assert.equal(siteIcon("wikipedia.org"), "https://wikipedia.org/favicon.ico");
  assert.equal(siteIcon("app.internal"), null);
});

test("landmark artwork uses a matching Commons photo and credit", async () => {
  const subject = "Giza Pyramids";
  const response = await landmarkPhoto(subject, new AbortController().signal, async (url) => {
    assert.equal(url.origin, "https://en.wikipedia.org");
    assert.equal(url.searchParams.get("gsrsearch"), subject);
    assert.equal(url.searchParams.get("pilicense"), "free");
    return Response.json({ query: { pages: [
      { index: 1, title: "Pyramid of Unas", pageimage: "Wrong.jpg", thumbnail: { source: "https://upload.wikimedia.org/wikipedia/commons/thumb/Wrong.jpg" } },
      { index: 2, title: "Giza pyramid complex", pageimage: "Giza.jpg", thumbnail: { source: "https://thumb.wikimedia.org/wikipedia/commons/thumb/Giza.jpg" } },
    ] } });
  });
  assert.deepEqual(response, {
    src: "https://thumb.wikimedia.org/wikipedia/commons/thumb/Giza.jpg",
    credit: "https://commons.wikimedia.org/wiki/File:Giza.jpg",
  });
});

test("review summaries and cards require citations to specific review pages", async () => {
  const summary = "Summary: Reviewers liked the noise cancellation but found the case bulky.";
  const review = "Headphone Lab review | Tested the noise cancellation and measured battery life.";
  const listing = "Store results | Retail category.";
  const url = "https://reviewlab.example/reviews/sony-xm5";
  const text = [summary, review, listing].join("\n");
  const annotations = [[summary, url], [review, url], [listing, "https://store.example/collections/headphones"]].map(([line, url]) => ({
    type: "url_citation", url, start_index: text.indexOf(line), end_index: text.indexOf(line) + line.length,
  }));
  const providers = createProviders({ apiKey: "test-key", fetcher: async () => Response.json({ steps: [
    { type: "google_search_result", result: [] },
    { type: "model_output", content: [{ type: "text", text, annotations }] },
  ] }) });
  const result = await providers.search({ kind: "review", query: "Sony WH-1000XM5 independent reviews" }, new AbortController().signal);
  assert.equal(result.summary, summary.slice("Summary: ".length));
  assert.deepEqual(result.destinations.map((item) => item.url), [url]);
});

test("recipe cards use the written recipe citation and never display raw URLs as copy", async () => {
  const url = "https://recipe.example/seared-steak";
  const text = "Seared steak recipe | " + url;
  const annotations = ["https://www.youtube.com/watch?v=ABCDEFGHIJK", url].map((citation) => ({
    type: "url_citation", url: citation, start_index: 0, end_index: text.length,
  }));
  const providers = createProviders({ apiKey: "test-key", fetcher: async (_url, options) => {
    assert.equal(JSON.parse(options.body).model, "gemini-3.5-flash-lite");
    return Response.json({ steps: [
      { type: "google_search_result", result: [] },
      { type: "model_output", content: [{ type: "text", text, annotations }] },
    ] });
  } });
  const result = await providers.search({ kind: "recipe", query: "seared steak recipe" }, AbortSignal.timeout(1000));
  assert.deepEqual(result.destinations, [{ title: "Seared steak recipe", reason: "", url, site: "recipe.example" }]);
});

test("web shopping accepts direct retailer product pages and checks their relevance in Decisions", async () => {
  const lines = ["Headphone category | Browse models.", "Sony WH-1000XM5 | Black color.",
    "Sony WH-1000XM5 case | Hard carrying case."];
  const urls = ["https://www.amazon.com/s?k=Xm5", "https://www.amazon.com/dp/B09XS7JWHH", "https://shop.example/products/xm5-case"];
  const text = lines.join("\n");
  const annotations = lines.map((line, index) => ({
    type: "url_citation", url: urls[index], start_index: text.indexOf(line), end_index: text.indexOf(line) + line.length,
  }));
  const product = { name: "Sony WH-1000XM5", description: "Black color", exact: true, evidence: "Model label is readable." };
  const providers = createProviders({ apiKey: "test-key", fetcher: async (url, options) => {
    const payload = JSON.parse(options.body);
    if (url.endsWith("decisions")) {
      assert.deepEqual(Object.keys(payload.questions), ["listing_0", "listing_1"]);
      assert.match(payload.input, /Hard carrying case/);
      return Response.json({ answers: { listing_0: { noul: 0.95 }, listing_1: { noul: 0.12 } } });
    }
    assert.match(payload.input, /Sony WH-1000XM5 Black color/);
    return Response.json({ steps: [
      { type: "google_search_result", result: [] },
      { type: "model_output", content: [{ type: "text", text, annotations }] },
    ] });
  } });
  const signal = new AbortController().signal;
  const { items } = await providers.merchantListings(product, signal);
  assert.deepEqual(items.map((item) => item.url), urls.slice(1));
  assert.deepEqual((await providers.verifyProducts(product, items, signal)).map((item) => item.url), [urls[1]]);
});

test("without a valid grounding citation, prose and generic URLs cannot become action links", async () => {
  const text = "Unrelated homepage | Looks plausible.";
  const providers = createProviders({ apiKey: "test-key", fetcher: async () => Response.json({ steps: [
    { type: "google_search_result", result: [] },
    { type: "model_output", content: [{
      type: "text", text,
      annotations: [
        ["example.com", "https://example.com/"],
        ["google.com", "https://www.google.com/?q=exact+tour"],
        ["google.com", "https://vertexaisearch.cloud.google.com/grounding-api-redirect/search-result"],
      ].map(([title, url]) => ({ type: "url_citation", title, url, start_index: 0, end_index: text.length })),
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
    assert.equal(params.arguments.catalog.query, "Packable rain jacket blue shell");
    assert.equal(params.arguments.catalog.view, "compact");
    assert.equal(params.arguments.catalog.filters.price.max, 10_000);
    return Response.json({ result: { structuredContent: {
      products: [{
        title: "Packable jacket",
        variants: [
          { url: "https://example.com/products/jacket?variant=41", availability: { available: false } },
          { url, price: { amount: 6400, currency: "USD" }, seller: { name: "Merchant" },
            media: [{ type: "video", url: "https://example.com/clip.mp4" }, { type: "image", url: "https://example.com/jacket.jpg" }] },
        ],
      }],
      messages: [{ type: "warning", content: "Some availability varies." }],
    } } });
  } });
  const result = await providers.shop({ name: "Packable rain jacket", description: "blue shell", maxUsd: 100 }, new AbortController().signal);
  assert.deepEqual(result, {
    warnings: ["Some availability varies."],
    items: [{ title: "Packable jacket", price: "$64.00", merchant: "Merchant", image: "https://example.com/jacket.jpg", url }],
  });
});

test("product links exclude Amazon searches and image matching preserves variants", () => {
  assert.equal(amazonItemUrl("https://m.amazon.com/Kindle/dp/B0CFPJYX7P?tag=affiliate"), "https://www.amazon.com/dp/B0CFPJYX7P");
  assert.equal(amazonItemUrl("https://www.amazon.com/gp/product/B0CFPJYX7P"), "https://www.amazon.com/dp/B0CFPJYX7P");
  assert.equal(amazonItemUrl("https://www.amazon.com/s?k=kindle"), null);
  assert.equal(amazonItemUrl("https://amazon.com.example.org/dp/B0CFPJYX7P"), null);
  assert.equal(productPhotoKey("Sony WH-1000XM5 Headphones, Black"), productPhotoKey("Sony WH-1000XM5 Black Headphones"));
  assert.notEqual(productPhotoKey("Sony WH-1000XM5 Headphones, Black"), productPhotoKey("Sony WH-1000XM5 Headphones, Silver"));
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
