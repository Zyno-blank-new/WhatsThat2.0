import { normalizeSections } from "./suggestions.js";

const minimumYes = 0.65;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function modelEvidence(result) {
  const candidate = result.product;
  const query = clean(candidate?.query, 240);
  const title = clean(candidate?.title, 60);
  const label = clean(candidate?.label, 80);
  const product = query && title && label ? {
    id: "catalog",
    title,
    label,
    query,
    evidence: clean(candidate.evidence, 300),
    maxUsd: Number.isFinite(candidate.maxUsd) ? candidate.maxUsd : null,
  } : null;
  const webQueries = result.webQueries.slice(0, 3).flatMap((entry, index) => {
    const query = clean(entry?.query, 220);
    const title = clean(entry?.title, 60);
    const label = clean(entry?.label, 80);
    const kind = clean(entry?.kind, 20);
    const evidence = clean(entry?.evidence, 240);
    return query && title && label && kind && evidence ? [{ id: "web_" + index, title, label, query, kind, evidence }] : [];
  });
  return { summary: clean(result.summary, 400), product, webQueries };
}

async function runLookups(providers, evidence, signal, send) {
  if (!evidence.product && !evidence.webQueries.length) return;
  const routing = await providers.decide(evidence, signal).catch((error) => {
    if (!signal.aborted) send("warning", { message: error.message });
    return null;
  });
  if (!routing || signal.aborted) return;
  const product = routing.shop >= minimumYes ? evidence.product : null;
  const queries = evidence.webQueries.filter((query) => routing[query.id] >= minimumYes);
  const links = [...(product ? [product] : []), ...queries].map(({ id, title, label }) => ({ id, title, label }));
  if (links.length) send("lookup", { links });

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
    ...queries.map((query) => search("web", query, () => providers.search(query, signal))),
  ]);
}

export async function inspectMoment(providers, moment, signal, send) {
  try {
    const result = await providers.analyze(moment, signal);
    send("context", { sections: normalizeSections(result.sections, 4) });
    await runLookups(providers, modelEvidence(result), signal, send);
  } catch (error) {
    if (!signal.aborted) send("error", { error: error.message });
  } finally {
    if (!signal.aborted) send("done");
  }
}
