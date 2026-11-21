import { normalizeSections } from "./suggestions.js";

const minimumYes = 0.65;

function clean(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function modelEvidence(result, moment) {
  const candidate = result.product;
  const product = clean(candidate?.query, 240) ? {
    label: clean(candidate.label, 80),
    query: clean(candidate.query, 240),
    evidence: clean(candidate.evidence, 300),
    maxUsd: Number.isFinite(candidate.maxUsd) ? candidate.maxUsd : null,
  } : null;
  return {
    summary: clean(result.summary, 400),
    product,
    pageProduct: moment.page?.product ?? null,
    webQueries: result.webQueries.slice(0, 3).flatMap((entry) => {
      const query = clean(entry?.query, 220);
      return query ? [{ label: clean(entry.label, 80) || query, query }] : [];
    }),
  };
}

async function runLookups(providers, evidence, signal, send) {
  const routing = await providers.decide(evidence, signal).catch((error) => {
    if (!signal.aborted) send("warning", { area: "lookup", message: error.message });
    return null;
  });
  if (!routing || signal.aborted) return;
  const shop = Boolean(evidence.product && routing.shop >= minimumYes);
  const web = Boolean(evidence.webQueries.length && routing.web >= minimumYes);
  send("lookup", { shop, web });

  const search = async (area, operation) => {
    try {
      send(area, await operation());
    } catch (error) {
      if (!signal.aborted) send("warning", { area, message: error.message });
    }
  };
  await Promise.all([
    shop && search("shop", () => providers.shop(evidence.product, signal)),
    web && search("web", () => providers.search(evidence.webQueries, evidence.summary, signal)),
  ]);
}

export async function inspectMoment(providers, moment, signal, send) {
  const start = performance.now();
  const pageProduct = moment.page?.product;
  const knownLookups = pageProduct?.name ? runLookups(providers, {
    summary: "The current page is about this named product.",
    product: { label: pageProduct.name, query: pageProduct.name, evidence: "Explicit product name on the current page.", maxUsd: null },
    pageProduct,
    webQueries: [{ label: "Prices and reviews", query: `Compare current US prices and find independent reviews for ${pageProduct.name}` }],
  }, signal, send) : null;
  try {
    const result = await providers.analyze(moment, signal);
    const sections = normalizeSections(result.sections, 4);
    send("context", { sections, elapsedMs: Math.round(performance.now() - start) });
    if (!knownLookups) await runLookups(providers, modelEvidence(result, moment), signal, send);
  } catch (error) {
    send("error", { error: error.message });
  } finally {
    await knownLookups;
    send("done");
  }
}
