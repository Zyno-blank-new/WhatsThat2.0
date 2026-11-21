import { answerMoment, inspectMoment, plainAnswer, verifyAnswer } from "./analysis.js";
import { landmarkPhoto, matchingVideoThumbnail, siteIcon, youtubeThumbnail, youtubeVideoId } from "./card-images.js";
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
  products: $("products"), productResults: $("product-results"), productsTitle: $("products-title"),
  focus: $("moment-focus"), focusImage: $("focus-image"), focusTitle: $("focus-title"),
  focusDetail: $("focus-detail"), focusPlaceholder: $("focus-placeholder"), focusActions: $("focus-actions"),
  focusRecipes: $("focus-recipes"), focusIngredients: $("focus-ingredients"), focusTip: $("focus-tip"), focusTipText: $("focus-tip-text"),
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
const webProductTitles = new Set();
const shownVideos = new Set();
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
  ui.skeleton.hidden = (!sectionsPending && !routingPending) || !ui.focusTitle.hidden ||
    Boolean(ui.sections.querySelector(".planned-skeleton"));
  const filled = Math.min(chipGroups.size, ui.skeleton.children.length - 1);
  for (const [index, row] of [...ui.skeleton.children].entries()) row.hidden = index < filled;
}

function startLoading(message) {
  sectionsPending = true;
  routingPending = true;
  setStatus(message, "busy");
  ui.focus.hidden = false;
  updateSkeletons();
}

function analysisError(message) {
  sectionsPending = false;
  routingPending = false;
  clearPlannedSections();
  setStatus(message, "error");
  if (ui.focusTitle.hidden) ui.focus.hidden = true;
  updateSkeletons();
}

function setNotice(message, error = false) {
  ui.notice.hidden = !message;
  ui.notice.textContent = message || "";
  ui.notice.classList.toggle("error", error);
}

function updateFocusActions() {
  const isDish = ui.focus.dataset.kind === "dish";
  ui.focusRecipes.hidden = !isDish || !ui.sections.querySelector('[data-kind="recipe"]');
  ui.focusIngredients.hidden = !isDish || ui.products.hidden || !ui.productResults.querySelector("[data-ingredient]");
  ui.focusActions.hidden = ui.focusRecipes.hidden && ui.focusIngredients.hidden;
}

function updateProducts() {
  ui.products.hidden = !productUrls.size && !ui.productResults.querySelector('[aria-busy="true"]');
  ui.productsTitle.textContent = ui.productResults.querySelector("[data-ingredient]") ? "Shop ingredients" : "Products";
  updateFocusActions();
}

function showFocus(focus) {
  if (!focus) return;
  const first = ui.focusTitle.hidden;
  ui.focus.hidden = false;
  ui.focus.dataset.kind = focus.kind;
  ui.focusPlaceholder.hidden = true;
  ui.focusTitle.hidden = ui.focusDetail.hidden = false;
  ui.focusTitle.textContent = focus.title;
  ui.focusDetail.textContent = focus.detail;
  ui.focusTip.hidden = !focus.tip;
  ui.focusTipText.textContent = focus.tip;
  updateFocusActions();
  if (first && moment) console.info("What’sThat? first scene insight", (Date.now() - moment.capturedAt) + " ms");
}

function resetFocus() {
  ui.focus.hidden = true;
  delete ui.focus.dataset.kind;
  ui.focusTitle.hidden = ui.focusDetail.hidden = ui.focusImage.hidden = ui.focusTip.hidden = true;
  ui.focusImage.removeAttribute("src");
  ui.focusPlaceholder.hidden = false;
  ui.focusTip.open = false;
  ui.focusActions.hidden = true;
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
  webProductTitles.clear();
  shownVideos.clear();
  catalogImages.clear();
  pendingProductImages.clear();
  ui.sections.replaceChildren(ui.products);
  ui.productResults.replaceChildren();
  resetFocus();
  updateProducts();
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
  if (!snapshot || !signal || item.pending || item.researching || (item.answer && !item.sourceQuery)) return;
  item.pending = !item.answer;
  item.researching = Boolean(item.answer);
  item.error = "";
  paintChipAnswer(group);
  try {
    const apiKey = await getGeminiKey();
    if (signal.aborted) return;
    if (!apiKey) throw new Error("Save your Gemini API key in Settings to open answers.");
    const providers = createProviders({ apiKey });
    if (item.answer) {
      item.answer = await verifyAnswer(providers, item.answer.answer, item.sourceQuery, signal);
      item.sourceQuery = "";
    } else {
      item.answer = await answerMoment(providers, snapshot, item.question, [], signal, (draft) => {
        if (signal.aborted) return;
        item.answer = draft;
        item.pending = false;
        item.researching = true;
        if (group.selected === item) paintChipAnswer(group);
      });
    }
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
    for (const { label, question, answer, sourceQuery } of chips) {
      const key = chipKey(label);
      const questionKey = chipKey(question);
      if (!key || chipEntries.has(key) || [...chipEntries.values()].some((entry) => entry.questionKey === questionKey)) continue;
      const group = getGroup(title, true);
      clearPlannedGroup(group);
      const item = { label, question, answer: answer ? plainAnswer(answer) : null, sourceQuery };
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

function showPlan(sections) {
  if (!sections.length) return;
  showSections(sections);
  for (const { title, layout, chips } of sections) {
    if (chips.length) continue;
    const group = getGroup(title, layout === "chips");
    if (group.placeholder || group.chips.children.length || group.lookups.children.length) continue;
    const placeholder = make("div", "planned-skeleton");
    placeholder.setAttribute("aria-hidden", "true");
    if (layout === "chips") {
      placeholder.classList.add("chips");
      placeholder.append(make("span", "skeleton skeleton-chip"), make("span", "skeleton skeleton-chip"));
    } else {
      placeholder.classList.add("skeleton-card");
      if (layout === "video") placeholder.append(make("span", "skeleton skeleton-thumbnail"));
      const lines = make("span", "skeleton-lines");
      lines.append(make("span", "skeleton"), make("span", "skeleton"));
      placeholder.append(lines);
    }
    group.block.append(placeholder);
    group.placeholder = placeholder;
  }
  updateSkeletons();
}

function clearPlannedGroup(group) {
  group.placeholder?.remove();
  group.placeholder = null;
}

function clearPlannedSections() {
  for (const group of chipGroups.values()) clearPlannedGroup(group);
  pruneEmptyGroups();
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
    if (group.placeholder || group.chips.children.length || group.lookups.children.length) continue;
    group.block.remove();
    chipGroups.delete(key);
  }
}

async function refineSuggestions(providers, value, signal) {
  const previews = [...chipEntries.values()];
  const final = value.sections.flatMap((section) => section.chips);
  const chips = [...previews.map((entry) => entry.item), ...final];
  receiveAnalysis({ type: "context", ...value });
  const matches = await providers.sameTopics(chips, signal).catch(() => new Set());
  if (signal.aborted || !matches.size) return;
  const retained = previews.flatMap(({ item, trigger }, index) => (
    item.used || trigger === document.activeElement ? [index] : []
  ));
  const sections = distinctTopics(value.sections, previews.length, retained, matches);
  const remaining = new Set(sections.flatMap((section) => section.chips.map((chip) => chipKey(chip.label))));
  for (const chip of final) {
    const key = chipKey(chip.label);
    const entry = chipEntries.get(key);
    if (remaining.has(key) || !entry || entry.item.used || entry.trigger === document.activeElement) continue;
    entry.trigger.remove();
    chipEntries.delete(key);
  }
  pruneEmptyGroups();
}

function mountLookups(links) {
  for (const { id, title, label, kind, name, exact, subject, ingredient } of links) {
    if (kind === "shop") {
      const body = make("div", "product-results");
      showPending(body, "Looking up products…");
      if (name) {
        body.dataset.heading = exact || ingredient ? name : "Similar to " + name;
        body.prepend(make("h3", "product-group-name", body.dataset.heading));
      }
      if (ingredient) body.dataset.ingredient = "";
      ui.productResults.append(body);
      lookupEntries.set(id, body);
      continue;
    }
    const group = getGroup(title, kind === "review");
    if (kind === "recipe") group.block.tabIndex = -1;
    clearPlannedGroup(group);
    const inline = kind !== "answer";
    const body = make("div", inline ? "lookup-inline" : "lookup-body");
    body.setAttribute("role", "status");
    if (inline) {
      body.dataset.kind = kind;
      if (kind === "review") body.dataset.reviewId = id;
      if (subject) body.dataset.subject = subject;
      const card = make("div", "skeleton-card");
      const lines = make("span", "skeleton-lines");
      card.setAttribute("aria-hidden", "true");
      if (kind === "video" || kind === "visit") card.append(make("span", "skeleton skeleton-thumbnail"));
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

function showShop({ id, items, source, complete, suggestions, visual }) {
  const block = lookupEntries.get(id);
  if (!block) return;
  const catalog = source === "shop";
  const isFirstProduct = !productUrls.size;
  const existingGrid = block.querySelector(".product-grid");
  const grid = existingGrid || make("div", "product-grid");
  const placeholders = [];
  for (const item of items) {
    const card = link(item.url, "product");
    if (!card || productUrls.has(card.href)) continue;
    const photoKey = productPhotoKey(item.title);
    const webTitle = source === "merchantListings" && photoKey && item.merchant + ":" + photoKey;
    if (webTitle && webProductTitles.has(webTitle)) continue;
    if (webTitle) webProductTitles.add(webTitle);
    productUrls.add(card.href);
    const photo = externalUrl(item.image);
    if (catalog && photoKey && photo) catalogImages.set(photoKey, photo);
    const placeholder = make("span", "product-placeholder");
    placeholder.setAttribute("aria-hidden", "true");
    if (!photo) addCardImage(placeholder, siteIcon(item.merchant) || siteIcon(new URL(card.href).hostname));
    if (!photo && !catalog) {
      if (photoKey) pendingProductImages.set(placeholder, photoKey);
      if (visual) placeholders.push(placeholder);
    }
    const image = photo ? makeProductImage(photo, placeholder) : placeholder;
    const copy = make("span");
    copy.append(make("span", "product-name", item.title),
      make("span", "product-meta", [item.price, item.merchant || new URL(card.href).hostname].filter(Boolean).join(" · ")));
    const arrow = make("span", "product-arrow", "↗");
    arrow.setAttribute("aria-hidden", "true");
    card.append(image, copy, arrow);
    grid.append(card);
  }
  if (grid.children.length && !existingGrid) {
    finishLookup(id);
    if (block.dataset.heading) block.append(make("h3", "product-group-name", block.dataset.heading));
    block.append(grid);
    if (isFirstProduct && moment) console.info("What’sThat? first product card", (Date.now() - moment.capturedAt) + " ms");
  }
  if (grid.children.length && suggestions?.length) appendSearchSuggestions(block, suggestions);
  if (complete && !grid.children.length) {
    block.remove();
    lookupEntries.delete(id);
  }
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
  const place = kind === "visit";
  const imageHolders = [];
  const type = { paper: "Research paper", person: "Biography", video: "Video", visit: "Visitor information", review: "Review", recipe: "Recipe", order: "Ordering page" }[kind];
  for (const { title, reason, url, site, videoUrl } of destinations) {
    const videoKey = video && (youtubeVideoId(url) || youtubeVideoId(videoUrl) || url);
    if (videoKey && shownVideos.has(videoKey)) continue;
    const card = link(url, video ? "destination destination-media destination-video"
      : place ? "destination destination-media" : "destination");
    if (!card) continue;
    if (videoKey) shownVideos.add(videoKey);
    const icon = make("span", video ? "destination-icon destination-preview"
      : place ? "destination-icon destination-place destination-document" : "destination-icon destination-document");
    icon.setAttribute("aria-hidden", "true");
    if (video) {
      const videoId = youtubeVideoId(url);
      if (videoId) addCardImage(icon, youtubeThumbnail(videoId));
      else if (videoUrl && controller) {
        void matchingVideoThumbnail(videoUrl, title, controller.signal).then((url) => {
          if (url && icon.isConnected) addCardImage(icon, url);
        });
      }
    } else {
      addCardImage(icon, siteIcon(site));
      if (place) imageHolders.push(icon);
    }
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
  if (imageHolders.length && block.dataset.subject && controller) {
    void landmarkPhoto(block.dataset.subject, controller.signal).then((photo) => {
      if (!photo || !list.isConnected) return;
      for (const icon of imageHolders) addCardImage(icon, photo.src, "landmark-image");
      const credit = link(photo.credit, "image-credit", "Photo credit · Wikimedia Commons");
      if (credit) list.after(credit);
    });
  }
  return Boolean(list.children.length);
}

function addCardImage(icon, url, className) {
  if (!url) return;
  const image = make("img", className);
  image.alt = "";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("load", () => icon.classList.add("has-image"), { once: true });
  image.addEventListener("error", () => image.remove(), { once: true });
  image.src = url;
  icon.append(image);
}

function showWeb({ id, blocks, destinations, suggestions, searched, summary }) {
  const block = finishLookup(id);
  if (!block) return;
  if (destinations) {
    const review = block.dataset.kind === "review";
    if (review && id === "preview_reviews" && block.parentElement.querySelector('[data-review-id="product_reviews"][data-has-results]')) {
      block.remove();
      lookupEntries.delete(id);
      return;
    }
    if (summary && review) block.append(make("p", "review-summary", summary));
    if (showDestinations(block, destinations)) {
      if (review) {
        block.dataset.hasResults = "";
        if (id === "product_reviews") {
          lookupEntries.get("preview_reviews")?.remove();
          lookupEntries.delete("preview_reviews");
        }
      }
      appendSearchSuggestions(block, suggestions);
    } else if (review && !block.parentElement.querySelector("[data-has-results]")) {
      block.append(make("p", "results-empty", "No independent reviews found for this model."));
    } else {
      block.remove();
      lookupEntries.delete(id);
      pruneEmptyGroups();
    }
    updateFocusActions();
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
  if (event.type === "preview") {
    showFocus(event.focus);
    showPlan(event.sections);
  }
  if (event.type === "context") {
    sectionsPending = false;
    showFocus(event.focus);
    if (event.sections.length) replaceSuggestions(event.sections);
    if (!routingPending) setStatus();
    updateSkeletons();
  }
  if (event.type === "lookup") {
    mountLookups(event.links);
    if (!event.preview) {
      routingPending = false;
      clearPlannedSections();
      setStatus();
    }
    updateProducts();
    updateSkeletons();
  }
  if (event.type === "shop") showShop(event);
  if (event.type === "web") showWeb(event);
  if (event.type === "warning") {
    if (event.id) {
      const block = finishLookup(event.id);
      if (event.message) block?.append(make("p", "notice error", event.message));
      else {
        block?.remove();
        lookupEntries.delete(event.id);
        pruneEmptyGroups();
      }
      updateProducts();
    }
    else setNotice(event.message, true);
  }
  if (event.type === "error") analysisError(event.error);
  if (event.type === "done") {
    routingPending = false;
    clearPlannedSections();
    if (!ui.status.classList.contains("error")) updateProducts();
    if (!sectionsPending && !ui.status.classList.contains("error")) {
      if (ui.focusTitle.hidden) ui.focus.hidden = true;
      setStatus(chipGroups.size || productUrls.size || !ui.focusTitle.hidden ? undefined : "There was too little context for specific suggestions.");
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
    await inspectMoment(providers, snapshot, signal, (type, value) => {
      if (signal.aborted) return;
      if (type === "context" && value.sections.length && chipEntries.size) {
        void refineSuggestions(providers, value, signal);
        return;
      }
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
  moment = { id: job.id, capturedAt: job.capturedAt, clip: job.clip, amazonItem: job.amazonItem, videoId: job.videoId };
  ui.question.disabled = false;
  ui.clip.src = job.clip.video;
  ui.preview.hidden = false;
  ui.preview.title = `Previous ${(job.clip.durationMs / 1000).toFixed(1)} seconds`;
  if (job.clip.durationMs < 3500) {
    ui.preview.title += " · Lookback just started";
  }
  controller = new AbortController();
  startLoading("Finding suggestions…");
  const signal = controller.signal;
  const seconds = Math.max(0, job.clip.durationMs / 1000 - 0.2);
  void productThumbnail(job.clip, { seconds, box: [0, 0, 1000, 1000] }, signal).then((image) => {
    if (!image || signal.aborted) return;
    ui.focusImage.src = image;
    ui.focusImage.hidden = false;
  });
  void consumeAnalysis(moment, signal);
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
ui.focusRecipes.addEventListener("click", () => {
  ui.sections.querySelector('[data-kind="recipe"]')?.closest("section")?.focus();
});
ui.focusIngredients.addEventListener("click", () => ui.products.focus());
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
