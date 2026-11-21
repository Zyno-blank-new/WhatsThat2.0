import { inspectMoment } from "./analysis.js";
import { getGeminiKey, setupKeySettings } from "./key-settings.js";
import { createProviders } from "./providers.js";
import { chipKey, distinctTopics } from "./suggestions.js";

const $ = (id) => document.getElementById(id);
const ui = {
  empty: $("empty"), capture: $("capture"), title: $("page-title"),
  source: $("source"), clip: $("clip"), skeleton: $("suggestion-skeleton"),
  preview: $("preview-button"), status: $("status"), notice: $("recording-note"),
  sections: $("sections"), conversation: $("conversation"),
  lookback: $("lookback"), lookbackLabel: $("lookback-label"), form: $("ask-form"),
  question: $("question"), ask: $("ask-button"),
};

if (!navigator.platform.toLowerCase().includes("mac")) $("modifier").textContent = "Alt";

let moment = null;
let controller = null;
let recent = [];
let renderedChip = false;
const chipGroups = new Map();
const chipEntries = new Map();
const lookupEntries = new Map();
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
  ui.skeleton.hidden = style !== "busy" || renderedChip;
}

function setNotice(message, error = false) {
  ui.notice.hidden = !message;
  ui.notice.textContent = message || "";
  ui.notice.classList.toggle("error", error);
}

function stopTask() {
  controller?.abort();
  controller = null;
  moment = null;
  recent = [];
  renderedChip = false;
  chipGroups.clear();
  chipEntries.clear();
  lookupEntries.clear();
  ui.sections.replaceChildren();
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
}

function preview(job) {
  ui.empty.hidden = true;
  ui.capture.hidden = false;
  ui.title.textContent = job.title;
  ui.source.textContent = job.host;
}

function getGroup(title) {
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
    ui.sections.append(group.block);
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
  } else {
    group.answer.textContent = selected?.answer || selected?.error || "";
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
    const answer = await createProviders({ apiKey }).followUp(snapshot, item.question, [], signal);
    item.answer = answer.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  } catch (error) {
    if (!signal.aborted) item.error = error.message;
  } finally {
    item.pending = false;
    if (!signal.aborted && group.selected === item) paintChipAnswer(group);
  }
}

function showSections(sections) {
  for (const { title, chips } of sections) {
    for (const { label, question } of chips) {
      const key = chipKey(label);
      const questionKey = chipKey(question);
      if (!key || chipEntries.has(key) || [...chipEntries.values()].some((entry) => entry.questionKey === questionKey)) continue;
      const group = getGroup(title);
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
    ui.skeleton.hidden = true;
    const elapsedMs = Date.now() - moment.capturedAt;
    console.info("What’sThat? first clickable chip", elapsedMs + " ms");
  }
}

function replaceSuggestions(sections) {
  // A reader can keep using the first chip while the complete analysis arrives.
  for (const [key, { item, trigger }] of chipEntries) {
    if (item.used || document.activeElement === trigger) continue;
    trigger.remove();
    chipEntries.delete(key);
  }
  for (const [key, group] of chipGroups) {
    if (group.chips.children.length || group.lookups.children.length) continue;
    group.block.remove();
    chipGroups.delete(key);
  }
  showSections(sections);
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
  for (const { id, title, label } of links) {
    const group = getGroup(title);
    const details = make("details", "lookup");
    const body = make("div", "lookup-body");
    body.setAttribute("role", "status");
    showPending(body, "Looking up results…");
    details.append(make("summary", "chip", label), body);
    group.lookups.append(details);
    lookupEntries.set(id, body);
  }
}

function finishLookup(id) {
  const body = lookupEntries.get(id);
  body?.replaceChildren();
  body?.removeAttribute("aria-busy");
  return body;
}

function showShop({ id, items, warnings }) {
  const block = finishLookup(id);
  if (!block) return;
  const grid = make("div", "product-grid");
  block.append(grid);
  for (const item of items) {
    const card = link(item.url, "product");
    if (!card) continue;
    const source = externalUrl(item.image);
    const image = source ? make("img") : make("span", "product-placeholder");
    if (source) {
      image.alt = "";
      image.src = source;
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("error", () => image.replaceWith(make("span", "product-placeholder")), { once: true });
    }
    const copy = make("span");
    copy.append(make("span", "product-name", item.title),
      make("span", "product-meta", [item.price, item.merchant].filter(Boolean).join(" · ")));
    card.append(image, copy, make("span", "product-arrow", "↗"));
    grid.append(card);
  }
  if (!grid.children.length) block.append(make("p", "results-empty", "Shopify returned no matching listings."));
  for (const message of warnings) block.append(make("p", "notice", message));
}

function showWeb({ id, blocks, suggestions, searched }) {
  const block = finishLookup(id);
  if (!block) return;
  if (!blocks.length || !searched) {
    block.append(make("p", "results-empty", "Google Search returned no grounded sources for this lookup."));
    return;
  }
  const card = make("div", "web-card");
  block.append(card);
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
    card.append(paragraph);
  }
  for (const html of suggestions) {
    const frame = make("iframe", "search-suggestions");
    frame.title = "Google Search suggestions";
    frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
    frame.referrerPolicy = "no-referrer";
    frame.srcdoc = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: https:">' + html;
    block.append(frame);
  }
}

function receiveAnalysis(event) {
  if (event.type === "context") {
    if (event.sections.length) replaceSuggestions(event.sections);
    if (!event.sections.length && !ui.sections.children.length) setStatus("There was too little context for specific suggestions.");
    else setStatus();
  }
  if (event.type === "lookup") {
    mountLookups(event.links);
    setStatus();
  }
  if (event.type === "shop") showShop(event);
  if (event.type === "web") showWeb(event);
  if (event.type === "warning") {
    if (event.id) finishLookup(event.id)?.append(make("p", "notice error", event.message));
    else setNotice(event.message, true);
  }
  if (event.type === "error") setStatus(event.error, "error");
}

async function consumeAnalysis(snapshot, signal) {
  try {
    const apiKey = await getGeminiKey();
    if (signal.aborted) return;
    if (!apiKey) {
      setStatus("Save your Gemini API key in Settings, then press the shortcut again.", "error");
      return;
    }
    const providers = createProviders({ apiKey });
    let fullAnalysisReady = false;
    void providers.quickChips(snapshot, signal).then((sections) => {
      if (signal.aborted || fullAnalysisReady || !sections.length) return;
      replaceSuggestions(sections);
      if (ui.status.textContent === "Finding suggestions…") setStatus();
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
    if (!signal.aborted) setStatus(error.message, "error");
  }
}

function begin(job) {
  if (moment?.id === job.id) return;
  stopTask();
  preview(job);
  moment = { id: job.id, capturedAt: job.capturedAt, clip: job.clip };
  ui.question.disabled = false;
  ui.clip.src = job.clip.video;
  ui.preview.hidden = false;
  ui.preview.title = `Previous ${(job.clip.durationMs / 1000).toFixed(1)} seconds`;
  if (job.clip.durationMs < 3500) {
    setNotice("Lookback just started. This first clip is shorter.");
  }
  controller = new AbortController();
  setStatus("Finding suggestions…", "busy");
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
      setStatus("Capturing this moment…", "busy");
    }
    if (event.type === "captured") begin(event.job);
    if (event.type === "recording") recordingState(event.enabled, event.error);
    if (event.type === "error") setStatus(event.error, "error");
    if (event.type === "panel-warning" && !moment) setStatus(event.message, "error");
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
  if (!hasKey) controller?.abort();
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
  const answer = make("p");
  answer.setAttribute("role", "status");
  showPending(answer, "Thinking…");
  turn.append(make("p", "question", question), answer);
  ui.conversation.append(turn);
  turn.scrollIntoView({ block: "nearest", behavior: "instant" });
  try {
    const result = await createProviders({ apiKey }).followUp(snapshot, question, recent, signal);
    if (signal.aborted) return;
    answer.textContent = result;
    recent.push({ question, answer: result });
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
