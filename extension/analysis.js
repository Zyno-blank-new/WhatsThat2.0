import { normalizeSections } from "./suggestions.js";

const minimumYes = 0.65;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function modelEvidence(result, prefix = "web") {
  const candidate = result.product;
  const query = clean(candidate?.query, 240);
  const evidence = clean(candidate?.evidence, 300);
  const product = query && evidence ? {
    id: "catalog",
    kind: "shop",
    query,
    evidence,
    exact: candidate.exact === true,
    maxUsd: Number.isFinite(candidate.maxUsd) ? candidate.maxUsd : null,
  } : null;
  const webQueries = result.webQueries.slice(0, 5).flatMap((entry, index) => {
    const query = clean(entry?.query, 220);
    const title = clean(entry?.title, 60);
    const label = clean(entry?.label, 80);
    const kind = clean(entry?.kind, 20);
    const subject = clean(entry?.subject, 200);
    const evidence = clean(entry?.evidence, 240);
    return query && title && label && kind && evidence
      ? [{ id: prefix + "_" + index, title, label, query, kind, subject, evidence }] : [];
  });
  return { summary: clean(result.summary, 400), product, webQueries };
}

function lookupKey(entry) {
  return entry.kind + ":" + (entry.subject || entry.query).normalize("NFKD").toLowerCase()
    .replace(/\p{Mark}/gu, "").replace(/ł/g, "l").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function startEarlyLookup(providers, plan, signal, send, early) {
  const evidence = modelEvidence({ webQueries: plan.webQueries }, "preview");
  const query = evidence.webQueries.find((entry) => entry.subject && ["paper", "person", "video"].includes(entry.kind));
  if (!query) return;
  evidence.webQueries = [query];
  const task = (async () => {
    const routing = await providers.decide(evidence, signal).catch(() => null);
    if (signal.aborted || !(routing?.[query.id] >= minimumYes)) return false;
    send("lookup", { links: [query], preview: true });
    const result = await providers.search(query, signal).catch(() => null);
    if (signal.aborted) return false;
    send("web", { id: query.id, destinations: result?.destinations ?? [], suggestions: result?.suggestions ?? [] });
    return Boolean(result?.destinations?.length);
  })();
  early.set(lookupKey(query), task);
  return task;
}

async function runLookups(providers, evidence, visual, amazonItem, signal, send, early) {
  if (!evidence.product && !evidence.webQueries.length) return;
  const routing = await providers.decide(evidence, signal).catch((error) => {
    if (!signal.aborted) send("warning", { message: error.message });
    return null;
  });
  if (!routing || signal.aborted) return;
  const product = routing.shop >= minimumYes ? evidence.product : null;
  const queries = evidence.webQueries.filter((query) => routing[query.id] >= minimumYes);
  const retail = product?.exact ? { id: "retail", kind: "retail" } : null;
  const currentAmazon = retail && amazonItem ? { id: "amazon-item", kind: "retail" } : null;
  const links = queries.filter((query) => !early.has(lookupKey(query)))
    .map(({ id, title, label, kind }) => ({ id, title, label, kind }));
  if (product) links.unshift({ id: product.id, kind: "shop" });
  if (retail) links.push(retail);
  if (currentAmazon) links.unshift(currentAmazon);
  send("lookup", { links });
  if (currentAmazon) send("shop", {
    id: currentAmazon.id, visual, items: [{ title: product.query, url: amazonItem, merchant: "amazon.com" }],
  });

  const search = async (type, entry, operation) => {
    try {
      const result = await operation();
      if (!signal.aborted) send(type, { id: entry.id, ...result });
    } catch (error) {
      if (!signal.aborted) send("warning", { id: entry.id, message: error.message });
    }
  };
  await Promise.all([
    product && search("shop", product, () => providers.shop(product, signal)),
    retail && search("shop", retail, async () => {
      const result = await providers.retail(product, signal);
      const items = currentAmazon ? result.items.filter((item) => item.merchant !== "amazon.com") : result.items;
      return { ...result, items, visual };
    }),
    ...queries.map(async (query) => {
      const prefetched = early.get(lookupKey(query));
      if (prefetched) {
        if (await prefetched || signal.aborted) return;
        send("lookup", { links: [query], preview: true });
      }
      return search("web", query, () => providers.search(query, signal));
    }),
  ]);
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
        earlyTask = startEarlyLookup(providers, plan, signal, send, early);
      }).catch(() => {});
    }
    const result = await providers.analyze(moment, signal);
    fullReady = true;
    const evidence = modelEvidence(result);
    send("context", { sections: normalizeSections(result.sections, 5), productCandidate: Boolean(evidence.product) });
    await runLookups(providers, evidence, result.product?.visual, moment.amazonItem, signal, send, early);
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
