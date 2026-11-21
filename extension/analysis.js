import { normalizeSections } from "./suggestions.js";

const minimumYes = 0.65;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function modelEvidence(result, preview = false) {
  const products = (Array.isArray(result.products) ? result.products : []).slice(0, 2).flatMap((candidate, index) => {
    const name = clean(candidate?.name, 100);
    const evidence = clean(candidate?.evidence, 240);
    if (!name || !evidence) return [];
    return [{
      id: (preview ? "preview_catalog_" : "catalog_") + index, kind: "shop", name, evidence,
      description: clean(candidate.description, 120), exact: candidate.exact === true,
      maxUsd: Number.isFinite(candidate.maxUsd) ? candidate.maxUsd : null,
    }];
  });
  const webQueries = (Array.isArray(result.webQueries) ? result.webQueries : []).slice(0, 5).flatMap((entry, index) => {
    const query = clean(entry?.query, 220);
    const title = clean(entry?.title, 60);
    const label = clean(entry?.label, 80);
    const kind = clean(entry?.kind, 20);
    const subject = clean(entry?.subject, 200);
    const evidence = clean(entry?.evidence, 240);
    return query && title && label && kind && evidence
      ? [{ id: (preview ? "preview_" : "web_") + index, title, label, query, kind, subject, evidence }] : [];
  });
  return { summary: clean(result.summary, 400), products, webQueries };
}

function lookupKey(entry) {
  return entry.kind + ":" + (entry.name || entry.subject || entry.query).normalize("NFKD").toLowerCase()
    .replace(/\p{Mark}/gu, "").replace(/ł/g, "l").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function matchingPrefetch(entry, early) {
  const key = lookupKey(entry);
  const match = early.get(key);
  if (match || entry.kind !== "shop" || entry.exact) return match;
  const words = new Set(key.slice("shop:".length).split(" "));
  for (const [otherKey, item] of early) {
    if (item.entry.kind !== "shop" || item.entry.exact) continue;
    const otherWords = new Set(otherKey.slice("shop:".length).split(" "));
    const shared = [...words].filter((word) => otherWords.has(word)).length;
    // Reuse "woven straw hat" for "woven straw sun hat" while keeping distinct styles.
    if (shared >= 3 && shared === Math.min(words.size, otherWords.size) &&
        Math.abs(words.size - otherWords.size) <= 1) return item;
  }
}

function lookupLink({ id, kind, title, label, name, exact }) {
  return kind === "shop" ? { id, kind, name, exact } : { id, kind, title, label };
}

async function fetchLookup(providers, entry, signal, send, preview = false) {
  const shopping = entry.kind === "shop";
  try {
    const result = await (shopping ? providers.shop(entry, signal) : providers.search(entry, signal));
    if (signal.aborted) return false;
    send(shopping ? "shop" : "web", { id: entry.id, ...result });
    return Boolean((shopping ? result.items : result.destinations)?.length);
  } catch (error) {
    if (!signal.aborted) send("warning", { id: entry.id, message: preview ? "" : error.message });
    return false;
  }
}

function startEarlyLookups(providers, plan, signal, send, early) {
  const evidence = modelEvidence(plan, true);
  evidence.webQueries = evidence.webQueries.filter((entry) =>
    entry.subject && ["paper", "person", "video"].includes(entry.kind)).slice(0, 1);
  const entries = [...evidence.products, ...evidence.webQueries];
  if (!entries.length) return;
  const routing = providers.decide(evidence, signal).catch(() => null);
  return Promise.all(entries.map((entry) => {
    const task = (async () => {
      const approved = await routing;
      if (signal.aborted || !(approved?.[entry.id] >= minimumYes)) return false;
      send("lookup", { links: [lookupLink(entry)], preview: true });
      return fetchLookup(providers, entry, signal, send, true);
    })();
    early.set(lookupKey(entry), { entry, task });
    return task;
  }));
}

async function runLookups(providers, evidence, result, amazonItem, signal, send, early) {
  if (!evidence.products.length && !evidence.webQueries.length) return;
  const routing = await providers.decide(evidence, signal).catch((error) => {
    if (!signal.aborted) send("warning", { message: error.message });
    return null;
  });
  if (!routing || signal.aborted) return;
  const approved = [...evidence.products, ...evidence.webQueries].filter((entry) => routing[entry.id] >= minimumYes);
  const reused = new Set();
  const matches = approved.map((entry) => {
    const prefetched = matchingPrefetch(entry, early);
    const compatible = prefetched && !reused.has(prefetched) && (!entry.exact || prefetched.entry.exact) &&
      entry.maxUsd === prefetched.entry.maxUsd;
    if (compatible) reused.add(prefetched);
    return { entry, prefetched: compatible ? prefetched.task : null };
  });
  const product = amazonItem && approved.find((entry) => entry.kind === "shop" && entry.exact);
  const currentAmazon = product ? { id: "amazon-item", kind: "shop" } : null;
  const links = matches.filter(({ prefetched }) => !prefetched).map(({ entry }) => lookupLink(entry));
  if (currentAmazon) links.unshift(currentAmazon);
  send("lookup", { links });
  if (currentAmazon) send("shop", {
    id: currentAmazon.id,
    visual: result.products.find(({ name }) => clean(name, 100) === product.name)?.visual,
    items: [{ title: product.name, url: amazonItem, merchant: "amazon.com" }],
  });

  await Promise.all(matches.map(async ({ entry, prefetched }) => {
    if (prefetched) {
      if (await prefetched || signal.aborted) return;
      send("lookup", { links: [lookupLink(entry)], preview: true });
    }
    return fetchLookup(providers, entry, signal, send);
  }));
}

export async function inspectMoment(providers, moment, signal, send) {
  const early = new Map();
  let fullReady = false;
  let earlyTask;
  try {
    if (providers.quickPlan) {
      void providers.quickPlan(moment, signal).then((plan) => {
        if (signal.aborted || fullReady) return;
        send("preview", { sections: plan.sections });
        earlyTask = startEarlyLookups(providers, plan, signal, send, early);
      }).catch(() => {});
    }
    const result = await providers.analyze(moment, signal);
    fullReady = true;
    const evidence = modelEvidence(result);
    send("context", { sections: normalizeSections(result.sections, 5) });
    await runLookups(providers, evidence, result, moment.amazonItem, signal, send, early);
    await earlyTask;
  } catch (error) {
    fullReady = true;
    if (!signal.aborted) send("error", { error: error.message });
    await earlyTask;
  } finally {
    if (!signal.aborted) send("done");
  }
}

export async function answerMoment(providers, moment, question, recent, signal, preview) {
  const { answer, searchQuery } = await providers.followUp(moment, question, recent, signal);
  return verifyAnswer(providers, answer, searchQuery, signal, preview);
}

export function plainAnswer(answer) {
  return { answer, blocks: [{ text: answer, citations: [] }], suggestions: [] };
}

export async function verifyAnswer(providers, answer, searchQuery, signal, preview) {
  const fallback = plainAnswer(answer);
  if (!searchQuery || signal.aborted) return fallback;
  preview?.(fallback);
  const grounded = await providers.search({ kind: "answer", query: searchQuery }, signal).catch(() => null);
  return grounded?.searched && grounded.blocks.some((block) => block.citations.length)
    ? { ...grounded, answer } : fallback;
}
