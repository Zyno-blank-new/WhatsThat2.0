const panels = new Map();
const jobs = new Map();
let recording = null;
let recorderCreation;
let lookbackChange = Promise.resolve();

function displayError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|not been invoked|host permission/i.test(message)) {
    return "Open What’sThat? from the toolbar on this tab, then enable lookback.";
  }
  return message;
}

function emit(windowId, message) {
  for (const port of panels.get(windowId) ?? []) {
    try {
      port.postMessage(message);
    } catch {
      // The panel can disconnect as the browser window closes.
    }
  }
}

async function ensureRecorder() {
  const path = "offscreen.html";
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(path)],
  });
  if (contexts.length) return;
  recorderCreation ??= chrome.offscreen.createDocument({
    url: path,
    reasons: ["USER_MEDIA"],
    justification: "Keep the enabled tab’s recent audio and video in memory.",
  }).finally(() => { recorderCreation = null; });
  return recorderCreation;
}

async function recorder(operation, fields = {}) {
  const response = await chrome.runtime.sendMessage({ target: "recorder", operation, ...fields });
  if (!response?.ok) throw new Error(response?.error || "Tab recording is unavailable.");
  return response.value;
}

async function activeTab(windowId) {
  return (await chrome.tabs.query({ active: true, windowId }))[0];
}

async function actualRecording() {
  if (!recording) {
    const captures = await chrome.tabCapture.getCapturedTabs();
    const tabId = captures.find((capture) => capture.status === "active" || capture.status === "pending")?.tabId;
    if (tabId !== undefined) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab) recording = { tabId, windowId: tab.windowId };
    }
  }
  return recording;
}

function updateRecording(windowId, enabled, error) {
  emit(windowId, { type: "recording", enabled, error });
}

async function stopLookback() {
  const previous = await actualRecording();
  if (!previous) return;
  recording = null;
  await recorder("stop").catch(() => {});
  updateRecording(previous.windowId, false);
}

function toggleLookback(tab) {
  lookbackChange = lookbackChange.catch(() => {}).then(async () => {
    if (!tab?.id || !/^https?:/.test(tab.url || "")) {
      throw new Error("Lookback is available on regular web tabs.");
    }
    if ((await actualRecording())?.tabId === tab.id) {
      await stopLookback();
      return false;
    }
    await stopLookback();
    updateRecording(tab.windowId, false);
    await ensureRecorder();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    await recorder("start", { streamId, tabId: tab.id });
    recording = { tabId: tab.id, windowId: tab.windowId };
    updateRecording(tab.windowId, true);
    return true;
  });
  return lookbackChange;
}

// This function is serialized and run in the active page by chrome.scripting.
function readPage() {
  const viewport = document.documentElement;
  const visible = (element) => {
    const box = element.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && box.top < viewport.clientHeight &&
      box.bottom > 0 && box.left < viewport.clientWidth && box.right > 0 &&
      getComputedStyle(element).visibility === "visible";
  };
  const clean = (text, limit) => String(text || "").replace(/\s+/g, " ").trim().slice(0, limit);
  const publicLink = (value) => {
    try {
      const url = new URL(value, document.baseURI);
      return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  };
  const root = document.querySelector("main, article, [role=main]") || document.body;
  const mainHeading = clean(root?.querySelector("h1")?.innerText, 180);
  const headings = [];
  const items = [];
  const seen = new Set();
  for (const element of root?.querySelectorAll("h1,h2,h3,h4,p,li,figcaption,dt,dd,blockquote,time") ?? []) {
    if (!visible(element)) continue;
    const text = clean(element.innerText, 350);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    items.push(text);
    if (headings.length < 4 && /^H[1-4]$/.test(element.tagName)) headings.push(text.slice(0, 160));
    if (items.length >= 28) break;
  }
  if (!items.length && root) {
    const x = [0.25, 0.5, 0.75].map((fraction) => viewport.clientWidth * fraction);
    const y = [0.25, 0.5, 0.75].map((fraction) => viewport.clientHeight * fraction);
    for (const left of x) for (const top of y) {
      const element = document.elementFromPoint(left, top);
      if (!element || element.closest("input,textarea,select,[contenteditable]")) continue;
      const text = clean(element.innerText, 180);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      items.push(text);
    }
  }
  const product = {};
  const title = document.querySelector("#productTitle");
  if (title && visible(title)) {
    product.name = clean(title.innerText, 180);
    const price = document.querySelector("#corePrice_feature_div .a-price .a-offscreen");
    product.price = clean(price?.textContent, 45);
  } else if (document.querySelector('meta[property="og:type"][content="product"]')) {
    product.name = clean(document.querySelector('h1')?.innerText, 180);
    const amount = document.querySelector('meta[property="product:price:amount"]')?.content;
    const currency = document.querySelector('meta[property="product:price:currency"]')?.content;
    if (amount && currency) product.price = clean(currency + " " + amount, 45);
  }
  const links = [];
  for (const link of root?.querySelectorAll("a[href]") ?? []) {
    if (!visible(link)) continue;
    const label = clean(link.innerText, 90);
    const url = publicLink(link.href);
    if (label && url) links.push({ label, url: url.origin + url.pathname });
    if (links.length >= 12) break;
  }
  const terms = [];
  for (const term of root?.querySelectorAll("dfn,abbr[title]") ?? []) {
    if (!visible(term)) continue;
    const label = clean(term.innerText, 80);
    if (label && !terms.includes(label)) terms.push(label);
    if (terms.length >= 2) break;
  }
  const video = [...document.querySelectorAll("video")].find(visible);
  return {
    mainHeading,
    headings,
    text: items.join("\n").slice(0, 5_000),
    links,
    videoTime: video && Number.isFinite(video.currentTime) ? video.currentTime : null,
    product: product.name ? product : null,
    terms,
  };
}

function safePageUrl(value) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  const youtubeId = url.hostname === "www.youtube.com" && url.pathname === "/watch"
    ? url.searchParams.get("v") : null;
  url.search = "";
  if (youtubeId) url.searchParams.set("v", youtubeId);
  return url.href;
}

async function captureMoment(tab) {
  if (!tab?.id || !/^https?:/.test(tab.url || "")) {
    if (tab?.windowId !== undefined) emit(tab.windowId, { type: "error", error: "Open a regular web tab first." });
    return;
  }
  const { windowId, id: tabId } = tab;
  const job = { id: crypto.randomUUID(), capturedAt: Date.now(), title: tab.title || "Current tab", url: safePageUrl(tab.url) };
  jobs.set(windowId, job);
  emit(windowId, { type: "capturing", job: { ...job } });

  // Capture the viewport immediately, before opening the panel resizes the page.
  const screenshotTask = chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
  const openTask = chrome.sidePanel.open({ windowId }).catch((error) => {
    emit(windowId, { type: "panel-warning", message: displayError(error) });
  });
  const pageTask = chrome.scripting.executeScript({ target: { tabId }, func: readPage })
    .then(([result]) => result.result).catch(() => null);
  const clipTask = actualRecording().then((session) => (
    session?.tabId === tabId ? recorder("snapshot", { tabId }) : null
  )).then((clip) => ({ clip }), (error) => ({ clip: null, warning: displayError(error) }));

  try {
    job.screenshot = await screenshotTask;
    const now = await activeTab(windowId);
    if (now?.id !== tabId || now.url !== tab.url) throw new Error("The page changed during capture. Try the shortcut again.");
    if (jobs.get(windowId) !== job) return;
    emit(windowId, { type: "preview", job: { ...job } });
    const [page, { clip, warning }] = await Promise.all([pageTask, clipTask]);
    if (jobs.get(windowId) !== job) return;
    job.page = page;
    job.clip = clip;
    job.warning = warning;
    job.ready = true;
    emit(windowId, { type: "captured", job: { ...job } });
  } catch (error) {
    if (jobs.get(windowId) !== job) return;
    job.error = displayError(error);
    emit(windowId, { type: "error", error: job.error });
  } finally {
    await openTask;
  }
}

chrome.action.onClicked.addListener((tab) => void captureMoment(tab));
chrome.commands.onCommand.addListener((command, tab) => {
  if (command === "analyze") void captureMoment(tab);
  if (command === "toggle-lookback") {
    void toggleLookback(tab).catch((error) => updateRecording(tab?.windowId, false, displayError(error)));
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidebar") return;
  let windowId;
  port.onMessage.addListener((message) => {
    if (message.type !== "subscribe" || windowId !== undefined) return;
    windowId = message.windowId;
    if (!panels.has(windowId)) panels.set(windowId, new Set());
    panels.get(windowId).add(port);
    const job = jobs.get(windowId);
    if (job) {
      const type = job.error ? "error" : job.ready ? "captured" : job.screenshot ? "preview" : "capturing";
      port.postMessage({ type, job, error: job.error });
    }
    void actualRecording().then((session) => updateRecording(windowId, session?.windowId === windowId));
  });
  port.onDisconnect.addListener(() => {
    panels.get(windowId)?.delete(port);
    if (!panels.get(windowId)?.size) {
      panels.delete(windowId);
      jobs.delete(windowId);
    }
  });
});

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.type === "lookback-ended") {
    if (recording?.tabId === message.tabId) {
      updateRecording(recording.windowId, false);
      recording = null;
    }
    return;
  }
  if (message.type !== "toggle-lookback") return;
  activeTab(message.windowId).then(toggleLookback).then(
    (enabled) => reply({ ok: true, enabled }),
    (error) => reply({ ok: false, error: displayError(error) }),
  );
  return true;
});

function stopIf(predicate) {
  lookbackChange = lookbackChange.catch(() => {}).then(async () => {
    const session = await actualRecording();
    if (session && predicate(session)) await stopLookback();
  });
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  stopIf((session) => session.windowId === windowId && session.tabId !== tabId);
  const job = jobs.get(windowId);
  if (job) {
    jobs.delete(windowId);
    emit(windowId, { type: "reset" });
  }
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== "loading") return;
  stopIf((session) => session.tabId === tabId);
  if (tab.active && jobs.has(tab.windowId)) {
    jobs.delete(tab.windowId);
    emit(tab.windowId, { type: "reset" });
  }
});
chrome.windows.onRemoved.addListener((windowId) => {
  jobs.delete(windowId);
  panels.delete(windowId);
  stopIf((session) => session.windowId === windowId);
});
