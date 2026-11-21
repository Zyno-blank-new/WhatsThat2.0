import { answerMoment, inspectMoment } from "./analysis.js";
import { productThumbnail } from "./clip-image.js";
import { getGeminiKey, setupKeySettings } from "./key-settings.js";
import { createProviders } from "./providers.js";
import { productPhotoKey } from "./products.js";
import { chipKey, distinctTopics } from "./suggestions.js";

const $ = (id) => document.getElementById(id);
const ui = {
  empty: $("empty"), capture: $("capture"), title: $("page-title"),
  source: $("source"), clip: $("clip"), skeleton: $("suggestion-skeleton"),
  preview: $("preview-button"), status: $("status"), notice: $("recording-note"),
  sections: $("sections"), conversation: $("conversation"),
  products: $("products"), productResults: $("product-results"), productStatus: $("product-status"),
  lookback: $("lookback"), lookbackLabel: $("lookback-label"), form: $("ask-form"),
  question: $("question"), ask: $("ask-button"),
};

if (!navigator.platform.toLowerCase().includes("mac")) $("modifier").textContent = "Alt";

let moment = null;
let controller = null;
let recent = [];
let renderedChip = false;
let sectionsPending = false;
let routingPending = false;
const chipGroups = new Map();
const chipEntries = new Map();
const lookupEntries = new Map();
const productUrls = new Set();
const catalogImages = new Map();
const pendingProductImages = new Map();
let port;
const windowId = (await chrome.windows.getCurrent()).id;

function make(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

function externalUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function link(url, className, text) {
  const href = externalUrl(url);
  if (!href) return null;
  const el = make("a", className, text);
  el.href = href;
  el.target = "_blank";
  el.rel = "noopener noreferrer";
  return el;
}

function setStatus(message, style = "") {
  ui.status.hidden = !message;
  ui.status.textContent = message || "";
  ui.status.className = "status";
  if (style) ui.status.classList.add(style === "busy" ? "visually-hidden" : style);
}

function updateSkeletons() {
  ui.skeleton.hidden = !sectionsPending && !routingPending;
  const filled = Math.min(chipGroups.size, ui.skeleton.children.length - 1);
  for (const [index, row] of [...ui.skeleton.children].entries()) row.hidden = index < filled;
}

function startLoading(message) {
  sectionsPending = true;
  routingPending = true;
  setStatus(message, "busy");
  setProductStatus("Checking for related products…");
  updateSkeletons();
}

function analysisError(message) {
  sectionsPending = false;
  routingPending = false;
  setStatus(message, "error");
  if (!productUrls.size) setProductStatus("Capture another moment to find related products.");
  updateSkeletons();
}

function setNotice(message, error = false) {
  ui.notice.hidden = !message;
  ui.notice.textContent = message || "";
  ui.notice.classList.toggle("error", error);
}

function setProductStatus(message = "") {
  ui.productStatus.hidden = !message;
  ui.productStatus.textContent = message;
}

function updateProducts() {
  if (productUrls.size || ui.productResults.querySelector('[aria-busy="true"]')) setProductStatus();
  else setProductStatus("No matching products for this moment.");
}

function stopTask() {
  controller?.abort();
  controller = null;
  moment = null;
  recent = [];
  renderedChip = false;
  sectionsPending = false;
  routingPending = false;
  chipGroups.clear();
  chipEntries.clear();
  lookupEntries.clear();
  productUrls.clear();
  catalogImages.clear();
  pendingProductImages.clear();
  ui.sections.replaceChildren(ui.products);
  ui.productResults.replaceChildren();
  setProductStatus("Capture a moment to find related products.");
  ui.conversation.replaceChildren();
  ui.question.value = "";
  ui.question.disabled = true;
  ui.ask.disabled = true;
  ui.clip.pause();
  ui.clip.removeAttribute("src");
  ui.clip.load();
  ui.clip.hidden = true;
  ui.preview.hidden = true;
  ui.preview.setAttribute("aria-expanded", "false");
  ui.preview.textContent = "View clip";
  setStatus();
  setNotice();
  updateSkeletons();
}

function preview(job) {
  ui.empty.hidden = true;
  ui.capture.hidden = false;
  ui.title.textContent = job.title;
  ui.source.textContent = job.host;
}

function getGroup(title, explanation = false) {
  if (title.toLowerCase() === "products") title = "Product details";
  const key = title.toLowerCase();
  let group = chipGroups.get(key);
  if (!group) {
    group = {
      block: make("section", "section"), chips: make("div", "chips"),
      answer: make("div", "answer"), lookups: make("div", "lookup-list"), selected: null,
    };
    group.answer.hidden = true;
    group.answer.setAttribute("role", "status");
    group.block.append(make("h2", "", title), group.chips, group.answer, group.lookups);
    ui.sections.insertBefore(group.block, explanation ? ui.products : null);
    chipGroups.set(key, group);
  }
  return group;
}

function showPending(container, label) {
  const lines = make("span", "skeleton-lines");
  lines.setAttribute("aria-hidden", "true");
  lines.append(make("span", "skeleton"), make("span", "skeleton"), make("span", "skeleton"));
  container.setAttribute("aria-busy", "true");
  container.replaceChildren(make("span", "visually-hidden", label), lines);
}

function paintChipAnswer(group) {
  const selected = group.selected;
  group.answer.hidden = !selected;
  if (selected?.pending) {
    showPending(group.answer, "Looking up this answer…");
  } else if (selected?.answer) {
    paintAnswer(group.answer, selected.answer, selected.researching);
  } else {
    group.answer.textContent = selected?.error || "";
    group.answer.removeAttribute("aria-busy");
  }
}

async function answerChip(group, item) {
  const snapshot = moment;
  const signal = controller?.signal;
  if (!snapshot || !signal || item.pending || item.answer) return;
  item.pending = true;
  item.error = "";
  paintChipAnswer(group);
  try {
    const apiKey = await getGeminiKey();
    if (signal.aborted) return;
    if (!apiKey) throw new Error("Save your Gemini API key in Settings to open answers.");
    item.answer = await answerMoment(createProviders({ apiKey }), snapshot, item.question, [], signal, (draft) => {
      if (signal.aborted) return;
      item.answer = draft;
      item.pending = false;
      item.researching = true;
      if (group.selected === item) paintChipAnswer(group);
    });
  } catch (error) {
    if (!signal.aborted) item.error = error.message;
  } finally {
    item.pending = false;
    item.researching = false;
    if (!signal.aborted && group.selected === item) paintChipAnswer(group);
  }
}

function showSections(sections) {
  for (const { title, chips } of sections) {
    for (const { label, question } of chips) {
      const key = chipKey(label);
      const questionKey = chipKey(question);
      if (!key || chipEntries.has(key) || [...chipEntries.values()].some((entry) => entry.questionKey === questionKey)) continue;
      const group = getGroup(title, true);
      const item = { label, question };
      const trigger = make("button", "chip", label);
      trigger.type = "button";
      trigger.setAttribute("aria-expanded", "false");
      trigger.addEventListener("click", () => {
        item.used = true;
        const show = group.selected !== item;
        group.selected = show ? item : null;
        for (const button of group.chips.children) {
          button.setAttribute("aria-expanded", String(show && button === trigger));
        }
        paintChipAnswer(group);
        if (show) void answerChip(group, item);
      });
      group.chips.append(trigger);
      chipEntries.set(key, { item, trigger, questionKey });
    }
  }
  if (chipEntries.size && !renderedChip && moment) {
    renderedChip = true;
    const elapsedMs = Date.now() - moment.capturedAt;
    console.info("What’sThat? first clickable chip", elapsedMs + " ms");
  }
  updateSkeletons();
}

function replaceSuggestions(sections) {
  // A reader can keep using the first chip while the complete analysis arrives.
  for (const [key, { item, trigger }] of chipEntries) {
    if (item.used || document.activeElement === trigger) continue;
    trigger.remove();
    chipEntries.delete(key);
  }
  pruneEmptyGroups();
  showSections(sections);
}

function pruneEmptyGroups() {
  for (const [key, group] of chipGroups) {
    if (group.chips.children.length || group.lookups.children.length) continue;
    group.block.remove();
    chipGroups.delete(key);
  }
}

async function refineSuggestions(providers, value, signal) {
  const previews = [...chipEntries.values()];
  const chips = [...previews.map((entry) => entry.item), ...value.sections.flatMap((section) => section.chips)];
  const matches = await providers.sameTopics(chips, signal).catch(() => new Set());
  if (signal.aborted) return;
  const retained = previews.flatMap(({ item, trigger }, index) => (
    item.used || trigger === document.activeElement ? [index] : []
  ));
  const sections = distinctTopics(value.sections, previews.length, retained, matches);
  receiveAnalysis({ type: "context", ...value, sections });
}

function mountLookups(links) {
  for (const { id, title, label, kind } of links) {
    if (kind === "shop" || kind === "retail") {
      const body = make("div", "product-results");
      showPending(body, "Looking up products…");
      ui.productResults.append(body);
      lookupEntries.set(id, body);
      continue;
    }
    const group = getGroup(title);
    const inline = kind !== "answer";
    const body = make("div", inline ? "lookup-inline" : "lookup-body");
    body.setAttribute("role", "status");
    if (inline) {
      body.dataset.kind = kind;
      const card = make("div", "skeleton-card");
      const lines = make("span", "skeleton-lines");
      card.setAttribute("aria-hidden", "true");
      if (kind === "video") card.append(make("span", "skeleton skeleton-thumbnail"));
      lines.append(make("span", "skeleton"), make("span", "skeleton"));
      card.append(lines);
      body.setAttribute("aria-busy", "true");
      body.append(make("span", "visually-hidden", "Looking up " + label), card);
      group.lookups.append(body);
    } else {
      const details = make("details", "lookup");
      showPending(body, "Looking up results…");
      details.append(make("summary", "chip", label), body);
      group.lookups.append(details);
    }
    lookupEntries.set(id, body);
  }
}

function finishLookup(id) {
  const body = lookupEntries.get(id);
  body?.replaceChildren();
  body?.removeAttribute("aria-busy");
  return body;
}

function showShop({ id, items, warnings = [], suggestions = [], visual }) {
  const block = finishLookup(id);
  if (!block) return;
  const grid = make("div", "product-grid");
  const placeholders = [];
  for (const item of items) {
    const card = link(item.url, "product");
    if (!card || productUrls.has(card.href)) continue;
    productUrls.add(card.href);
    const source = externalUrl(item.image);
    const photoKey = productPhotoKey(item.title);
    if (id === "catalog" && photoKey && source) catalogImages.set(photoKey, source);
    const placeholder = make("span", "product-placeholder");
    placeholder.setAttribute("aria-hidden", "true");
    if (!source && id !== "catalog") {
      if (photoKey) pendingProductImages.set(placeholder, photoKey);
      if (visual) placeholders.push(placeholder);
    }
    const image = source ? makeProductImage(source, placeholder) : placeholder;
    const copy = make("span");
    copy.append(make("span", "product-name", item.title),
      make("span", "product-meta", [item.price, item.merchant || new URL(card.href).hostname].filter(Boolean).join(" · ")));
    const arrow = make("span", "product-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    card.append(image, copy, arrow);
    grid.append(card);
  }
  if (grid.children.length) {
    block.append(grid);
    appendSearchSuggestions(block, suggestions);
  }
  for (const message of warnings) block.append(make("p", "notice", message));
  if (!block.children.length) block.remove();
  updateProducts();

  fillProductImages();
  if (placeholders.length && moment && controller) {
    void productThumbnail(moment.clip, visual, controller.signal).then((image) => {
      if (!image) return;
      for (const placeholder of placeholders) {
        if (placeholder.isConnected) {
          placeholder.replaceWith(makeProductImage(image, placeholder, "Product as shown in your clip"));
          pendingProductImages.delete(placeholder);
        }
      }
    });
  }
}

function fillProductImages() {
  for (const [placeholder, key] of pendingProductImages) {
    const source = catalogImages.get(key);
    if (!source || !placeholder.isConnected) continue;
    placeholder.replaceWith(makeProductImage(source, placeholder, "Catalog photo of the matching product"));
    pendingProductImages.delete(placeholder);
  }
}

function makeProductImage(source, placeholder, description = "") {
  const image = make("img");
  image.alt = description;
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => image.replaceWith(placeholder), { once: true });
  image.src = source;
  return image;
}

function showDestinations(block, destinations) {
  const list = make("div", "destinations");
  const kind = block.dataset.kind;
  const video = kind === "video";
  const type = { paper: "Research paper", person: "Biography", video: "Video", visit: "Visitor information", order: "Ordering page" }[kind];
  for (const { title, reason, url, site } of destinations) {
    const card = link(url, "destination");
    if (!card) continue;
    const icon = make("span", video ? "destination-icon destination-preview" : "destination-icon destination-document");
    icon.setAttribute("aria-hidden", "true");
    const copy = make("span", "destination-copy");
    const meta = make("span", "destination-meta");
    if (type) meta.append(type + " · ");
    meta.append(make("span", "destination-site", site));
    copy.append(make("span", "destination-title", title), meta);
    if (reason) copy.append(make("span", "destination-reason", reason));
    const arrow = make("span", "destination-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    card.append(icon, copy, arrow);
    list.append(card);
  }
  if (list.children.length) block.append(list);
  return Boolean(list.children.length);
}

function showWeb({ id, blocks, destinations, suggestions, searched }) {
  const block = finishLookup(id);
  if (!block) return;
  if (destinations) {
    if (showDestinations(block, destinations)) {
      appendSearchSuggestions(block, suggestions);
    } else {
      block.remove();
      lookupEntries.delete(id);
      pruneEmptyGroups();
    }
    return;
  }
  if (!blocks.length || !searched) {
    block.append(make("p", "results-empty", "Google Search returned no grounded sources for this lookup."));
    return;
  }
  const card = make("div", "web-card");
  block.append(card);
  appendCitedText(card, blocks);
  appendSearchSuggestions(block, suggestions);
}

function paintAnswer(container, { answer, blocks, suggestions }, researching = false) {
  container.replaceChildren();
  container.removeAttribute("aria-busy");
  let sourceContainer = container;
  const long = blocks.reduce((count, block) => count + (block.text?.length ?? 0), 0) > 700;
  if (long && blocks.some((block) => block.citations.length)) {
    appendCitedText(container, [{ text: answer, citations: [] }]);
    sourceContainer = make("details", "answer-details");
    sourceContainer.append(make("summary", "", "Sources and more detail"));
    container.append(sourceContainer);
  }
  appendCitedText(sourceContainer, blocks);
  appendSearchSuggestions(sourceContainer, suggestions);
  if (researching) {
    const pending = make("span", "answer-source-pending");
    const bar = make("span", "skeleton");
    bar.setAttribute("aria-hidden", "true");
    pending.append(make("span", "visually-hidden", "Checking sources…"), bar);
    container.append(pending);
  }
}

function appendCitedText(container, blocks) {
  let sourceIndex = 0;
  for (const result of blocks) {
    const paragraph = make("p");
    const text = result.text || "";
    const citations = [...result.citations].sort((a, b) => a.end - b.end);
    let index = 0;
    for (const citation of citations) {
      if (Number.isInteger(citation.end) && citation.end >= index && citation.end <= text.length) {
        paragraph.append(text.slice(index, citation.end));
        index = citation.end;
      }
      const source = link(citation.url, "citation", String(++sourceIndex));
      if (source) {
        source.title = citation.title || "Open source";
        source.setAttribute("aria-label", source.title);
        paragraph.append(source);
      }
    }
    paragraph.append(text.slice(index));
    container.append(paragraph);
  }
}

function appendSearchSuggestions(block, suggestions) {
  if (!suggestions.length) return;
  const disclosure = make("details", "related-searches");
  disclosure.append(make("summary", "", "Related searches"));
  const rail = make("div", "search-rail");
  if (suggestions.length > 1) {
    rail.tabIndex = 0;
    rail.setAttribute("role", "region");
    rail.setAttribute("aria-label", "Google Search suggestions");
  }
  for (const html of suggestions) {
    const frame = make("iframe", "search-suggestions");
    frame.title = "Google Search suggestions";
    frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    frame.referrerPolicy = "no-referrer";
    frame.srcdoc = '<meta name="color-scheme" content="dark">' +
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:">' + html;
    rail.append(frame);
  }
  disclosure.append(rail);
  block.append(disclosure);
}

function receiveAnalysis(event) {
  if (event.type === "context") {
    sectionsPending = false;
    if (!event.productCandidate) updateProducts();
    if (event.sections.length) replaceSuggestions(event.sections);
    if (!routingPending) setStatus();
    updateSkeletons();
  }
  if (event.type === "lookup") {
    routingPending = false;
    mountLookups(event.links);
    updateProducts();
    setStatus();
    updateSkeletons();
  }
  if (event.type === "shop") showShop(event);
  if (event.type === "web") showWeb(event);
  if (event.type === "warning") {
    if (event.id) {
      finishLookup(event.id)?.append(make("p", "notice error", event.message));
      if (event.id === "catalog" || event.id === "retail") updateProducts();
    }
    else setNotice(event.message, true);
  }
  if (event.type === "error") analysisError(event.error);
  if (event.type === "done") {
    routingPending = false;
    if (!ui.status.classList.contains("error")) updateProducts();
    if (!sectionsPending && !ui.status.classList.contains("error")) {
      setStatus(chipGroups.size || productUrls.size ? undefined : "There was too little context for specific suggestions.");
    }
    updateSkeletons();
  }
}

async function consumeAnalysis(snapshot, signal) {
  try {
    const apiKey = await getGeminiKey();
    if (signal.aborted) return;
    if (!apiKey) {
      analysisError("Save your Gemini API key in Settings, then press the shortcut again.");
      return;
    }
    const providers = createProviders({ apiKey });
    let fullAnalysisReady = false;
    void providers.quickChips(snapshot, signal).then((sections) => {
      if (signal.aborted || fullAnalysisReady || !sections.length) return;
      replaceSuggestions(sections);
      if (!sectionsPending && !routingPending && !ui.status.classList.contains("error")) setStatus();
    }).catch(() => {
      // Hydrogen can still supply chips when the quick request fails.
    });
    await inspectMoment(providers, snapshot, signal, (type, value) => {
      if (signal.aborted) return;
      if (type === "context" && value.sections.length && chipEntries.size) {
        fullAnalysisReady = true;
        void refineSuggestions(providers, value, signal);
        return;
      }
      if (type === "context" && value.sections.length) fullAnalysisReady = true;
      receiveAnalysis({ type, ...value });
    });
  } catch (error) {
    if (!signal.aborted) analysisError(error.message);
  }
}

function begin(job) {
  if (moment?.id === job.id) return;
  stopTask();
  preview(job);
  moment = { id: job.id, capturedAt: job.capturedAt, clip: job.clip, amazonItem: job.amazonItem };
  ui.question.disabled = false;
  ui.clip.src = job.clip.video;
  ui.preview.hidden = false;
  ui.preview.title = `Previous ${(job.clip.durationMs / 1000).toFixed(1)} seconds`;
  if (job.clip.durationMs < 3500) {
    setNotice("Lookback just started. This first clip is shorter.");
  }
  controller = new AbortController();
  startLoading("Finding suggestions…");
  void consumeAnalysis(moment, controller.signal);
}

function recordingState(enabled, error) {
  ui.lookback.setAttribute("aria-pressed", String(enabled));
  ui.lookbackLabel.textContent = enabled ? "Lookback on" : "Start lookback";
  if (error) setNotice(error, true);
  else if (!moment) setNotice();
}

function connect() {
  port = chrome.runtime.connect({ name: "sidebar" });
  port.onMessage.addListener((event) => {
    if (event.type === "capturing") {
      stopTask();
      preview(event.job);
      startLoading("Capturing this moment…");
    }
    if (event.type === "captured") begin(event.job);
    if (event.type === "recording") recordingState(event.enabled, event.error);
    if (event.type === "error") analysisError(event.error);
    if (event.type === "panel-warning" && !moment) analysisError(event.message);
    if (event.type === "reset") {
      stopTask();
      ui.capture.hidden = true;
      ui.empty.hidden = false;
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 200));
  port.postMessage({ type: "subscribe", windowId });
}
connect();
setupKeySettings((hasKey) => {
  if (!hasKey && controller) {
    stopTask();
    ui.capture.hidden = true;
    ui.empty.hidden = false;
  }
  if (!hasKey || ui.status.classList.contains("error")) {
    setStatus(hasKey ? "Key saved. Press the shortcut to analyze." : "Set a Gemini API key to analyze this tab.");
  }
});

ui.lookback.addEventListener("click", async () => {
  ui.lookback.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: "toggle-lookback", windowId });
    recordingState(Boolean(response?.enabled), response?.error);
  } catch (error) {
    setNotice(error.message, true);
  } finally {
    ui.lookback.disabled = false;
  }
});
ui.preview.addEventListener("click", () => {
  ui.clip.hidden = !ui.clip.hidden;
  ui.preview.textContent = ui.clip.hidden ? "View clip" : "Hide clip";
  ui.preview.setAttribute("aria-expanded", String(!ui.clip.hidden));
  if (ui.clip.hidden) ui.clip.pause();
});
$("capture-help").addEventListener("click", (event) => {
  const details = $("privacy-details");
  details.hidden = !details.hidden;
  event.currentTarget.setAttribute("aria-expanded", String(!details.hidden));
});
ui.question.addEventListener("input", () => { ui.ask.disabled = !moment || !ui.question.value.trim(); });
ui.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = ui.question.value.trim();
  if (!moment || !question || ui.question.disabled) return;
  const snapshot = moment;
  const signal = controller.signal;
  const apiKey = await getGeminiKey().catch(() => "");
  if (signal.aborted || snapshot !== moment || ui.question.disabled) return;
  if (!apiKey) {
    setStatus("Save your Gemini API key in Settings to ask a question.", "error");
    return;
  }
  ui.question.value = "";
  ui.question.disabled = true;
  ui.ask.disabled = true;
  const turn = make("article", "turn");
  const answer = make("div", "turn-answer");
  answer.setAttribute("role", "status");
  showPending(answer, "Thinking…");
  turn.append(make("p", "question", question), answer);
  ui.conversation.append(turn);
  turn.scrollIntoView({ block: "nearest", behavior: "instant" });
  try {
    const result = await answerMoment(createProviders({ apiKey }), snapshot, question, recent, signal, (draft) => {
      if (!signal.aborted) paintAnswer(answer, draft, true);
    });
    if (signal.aborted) return;
    paintAnswer(answer, result);
    recent.push({ question, answer: result.answer });
    recent = recent.slice(-6);
  } catch (error) {
    if (!signal.aborted) answer.textContent = error.message;
  } finally {
    if (!signal.aborted) {
      answer.removeAttribute("aria-busy");
      ui.question.disabled = false;
      ui.question.focus();
    }
  }
});
