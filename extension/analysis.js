import { normalizeSections } from "./suggestions.js";

const minimumYes = 0.65;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function modelEvidence(result) {
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
    const evidence = clean(entry?.evidence, 240);
    return query && title && label && kind && evidence ? [{ id: "web_" + index, title, label, query, kind, evidence }] : [];
  });
  return { summary: clean(result.summary, 400), product, webQueries };
}

async function runLookups(providers, evidence, visual, amazonItem, signal, send) {
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
  const links = queries.map(({ id, title, label, kind }) => ({ id, title, label, kind }));
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
    ...queries.map((query) => search("web", query, () => providers.search(query, signal))),
  ]);
}

export async function inspectMoment(providers, moment, signal, send) {
  try {
    const result = await providers.analyze(moment, signal);
    const evidence = modelEvidence(result);
    send("context", { sections: normalizeSections(result.sections, 5), productCandidate: Boolean(evidence.product) });
    await runLookups(providers, evidence, result.product?.visual, moment.amazonItem, signal, send);
  } catch (error) {
    if (!signal.aborted) send("error", { error: error.message });
  } finally {
    if (!signal.aborted) send("done");
  }
}

export async function answerMoment(providers, moment, question, recent, signal, preview) {
  const { answer, searchQuery } = await providers.followUp(moment, question, recent, signal);
  const fallback = { answer, blocks: [{ text: answer, citations: [] }], suggestions: [] };
  if (!searchQuery || signal.aborted) return fallback;
  preview(fallback);
  const grounded = await providers.search({ kind: "answer", query: searchQuery }, signal).catch(() => null);
  return grounded?.searched && grounded.blocks.some((block) => block.citations.length)
    ? { ...grounded, answer } : fallback;
}
