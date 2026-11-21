import { amazonItemUrl } from "./products.js";
import { youtubeVideoId } from "./card-images.js";

const panels = new Map();
const jobs = new Map();
const pausedTabs = new Set();
const savedPauses = chrome.storage.session.get("pausedLookbackTabs").then(({ pausedLookbackTabs = [] }) => {
  for (const id of pausedLookbackTabs) pausedTabs.add(id);
}).catch(() => {});
let recording = null;
let lookbackChange = Promise.resolve();
let activation = 0;

const webTab = (tab) => tab?.id !== undefined && /^https?:/.test(tab.url || "");

function displayError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|not been invoked|host permission/i.test(message)) {
    return "Press the shortcut on this tab so Chrome can start lookback.";
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

function updateRecording(windowId, enabled, error) {
  emit(windowId, { type: "recording", enabled, error });
}

async function ensureRecorder() {
  const path = "offscreen.html";
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(path)],
  });
  if (!contexts.length) await chrome.offscreen.createDocument({
    url: path,
    reasons: ["USER_MEDIA"],
    justification: "Keep the active tab’s recent audio and video in memory.",
  });
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
  if (!recording) recording = await recorder("status").catch(() => null);
  return recording;
}

function changeLookback(operation) {
  lookbackChange = lookbackChange.catch(() => {}).then(() => savedPauses).then(operation);
  return lookbackChange;
}

async function setPaused(tabId, paused) {
  if (pausedTabs.has(tabId) === paused) return;
  if (paused) pausedTabs.add(tabId);
  else pausedTabs.delete(tabId);
  await chrome.storage.session.set({ pausedLookbackTabs: [...pausedTabs] });
}

async function stopLookback(session) {
  if (!session) return;
  recording = null;
  await recorder("stop").catch(() => {});
  updateRecording(session.windowId, false);
}

async function startLookback(tab) {
  const current = await actualRecording();
  const origin = new URL(tab.url).origin;
  if (current?.tabId === tab.id && current.origin === origin) return;
  await stopLookback(current);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureRecorder();
  const [selected, window] = await Promise.all([activeTab(tab.windowId), chrome.windows.get(tab.windowId)]);
  if (!window.focused || selected?.id !== tab.id || !webTab(selected) || new URL(selected.url).origin !== origin) {
    throw new Error("The active tab changed before Lookback started.");
  }
  const session = { tabId: tab.id, windowId: tab.windowId, origin };
  await recorder("start", { streamId, ...session });
  recording = session;
  updateRecording(tab.windowId, true);
}

function toggleLookback(tab) {
  return changeLookback(async () => {
    if (!webTab(tab)) throw new Error("Lookback is available on regular web tabs.");
    const current = await actualRecording();
    if (current?.tabId === tab.id) {
      await setPaused(tab.id, true);
      await stopLookback(current);
      return false;
    }
    await setPaused(tab.id, false);
    await startLookback(tab);
    return true;
  });
}

async function recentClip(tabId) {
  const deadline = Date.now() + 2400;
  do {
    const clip = await recorder("snapshot", { tabId });
    if (clip?.durationMs >= 900) return clip;
    if (Date.now() >= deadline) return clip;
    await new Promise((resolve) => setTimeout(resolve, 225));
  } while (true);
}

async function captureMoment(tab) {
  if (!webTab(tab)) {
    if (tab?.windowId !== undefined) emit(tab.windowId, { type: "error", error: "Open a regular web tab first." });
    return;
  }
  const { windowId, id: tabId } = tab;
  const job = {
    id: crypto.randomUUID(), capturedAt: Date.now(),
    title: tab.title || "Current tab", host: new URL(tab.url).hostname.replace(/^www\./, ""),
    amazonItem: amazonItemUrl(tab.url),
    videoId: youtubeVideoId(tab.url),
  };
  jobs.set(windowId, job);
  emit(windowId, { type: "capturing", job: { ...job } });

  // Chrome requires opening the panel while the shortcut gesture is active.
  const openTask = chrome.sidePanel.open({ windowId }).catch((error) => {
    emit(windowId, { type: "panel-warning", message: displayError(error) });
  });
  try {
    await changeLookback(async () => {
      await setPaused(tabId, false);
      await startLookback(tab);
    });
    if (jobs.get(windowId) !== job) return;
    const clip = await recentClip(tabId);
    if (jobs.get(windowId) !== job) return;
    if (!clip) throw new Error("Lookback is on. Press the shortcut again after a few seconds.");
    const current = await activeTab(windowId);
    if (current?.id !== tabId || current.url !== tab.url) return;
    if (jobs.get(windowId) !== job) return;
    job.clip = clip;
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
      const type = job.error ? "error" : job.clip ? "captured" : "capturing";
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

function resetPanel(windowId) {
  if (!jobs.delete(windowId)) return;
  emit(windowId, { type: "reset" });
}

function followActiveTab(windowId, tabId) {
  const request = ++activation;
  void changeLookback(async () => {
    if (request !== activation) return;
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      await stopLookback(await actualRecording());
      return;
    }
    const window = await chrome.windows.get(windowId).catch(() => null);
    if (!window?.focused || request !== activation) return;
    const tab = await activeTab(windowId);
    if (request !== activation || (tabId !== undefined && tab?.id !== tabId)) return;
    const current = await actualRecording();
    if (current && current.tabId !== tab?.id) await stopLookback(current);
    if (webTab(tab) && !pausedTabs.has(tab.id)) {
      await startLookback(tab).catch(() => updateRecording(windowId, false));
    }
  }).catch(() => {});
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  resetPanel(windowId);
  followActiveTab(windowId, tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.active) {
    void chrome.windows.get(tab.windowId).then((window) => {
      if (window.focused) followActiveTab(tab.windowId, tabId);
    }).catch(() => {});
  }
  if (!change.url && change.status !== "loading") return;
  if (tab.active) resetPanel(tab.windowId);
  void changeLookback(async () => {
    const current = await actualRecording();
    if (current?.tabId !== tabId) return;
    if (webTab(tab) && new URL(tab.url).origin === current.origin) await recorder("reset", { tabId });
    else await stopLookback(current);
  }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void changeLookback(() => setPaused(tabId, false)).catch(() => {});
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  followActiveTab(windowId);
});
void chrome.windows.getLastFocused().then((window) => {
  if (window.focused) followActiveTab(window.id);
}).catch(() => {});
chrome.windows.onRemoved.addListener((windowId) => {
  jobs.delete(windowId);
  panels.delete(windowId);
  void changeLookback(async () => {
    const current = await actualRecording();
    if (current?.windowId === windowId) await stopLookback(current);
  }).catch(() => {});
});
