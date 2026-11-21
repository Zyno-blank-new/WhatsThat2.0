import { WebmLookback } from "./webm.js";

const previewWindowMs = 3200;
let active = null;

function options(streamId, extra = {}) {
  return { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId, ...extra } };
}

async function stop(session = active) {
  if (!session || active !== session) return;
  active = null;
  if (session.recorder?.state === "recording") session.recorder.stop();
  session.stream.getTracks().forEach((track) => track.stop());
  await session.audio?.close().catch(() => {});
}

function record(session) {
  const prior = session.recorder;
  if (prior?.state === "recording") {
    prior.ondataavailable = null;
    prior.stop();
  }
  const buffer = new WebmLookback();
  session.buffer = buffer;
  session.reading = Promise.resolve();
  session.error = "";
  const recorder = new MediaRecorder(session.stream, {
    mimeType: "video/webm;codecs=vp8,opus",
    videoBitsPerSecond: 720_000,
    audioBitsPerSecond: 48_000,
    videoKeyFrameIntervalDuration: 400,
  });
  session.recorder = recorder;
  recorder.ondataavailable = ({ data }) => {
    if (!data.size) return;
    session.reading = session.reading
      .then(async () => buffer.append(new Uint8Array(await data.arrayBuffer())))
      .catch((error) => {
        if (session.recorder === recorder) session.error = error.message;
      });
  };
  recorder.addEventListener("error", () => {
    if (session.recorder === recorder) session.ended();
  }, { once: true });
  recorder.start(200);
}

async function start({ streamId, tabId, windowId, origin }) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: options(streamId),
    video: options(streamId, { maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 }),
  });
  const session = { stream, tabId, windowId, origin };
  active = session;
  try {
    if (stream.getAudioTracks().length) {
      session.audio = new AudioContext();
      session.audio.createMediaStreamSource(stream).connect(session.audio.destination);
      await session.audio.resume();
    }
    session.ended = () => {
      if (active !== session) return;
      void stop(session);
      void chrome.runtime.sendMessage({ type: "lookback-ended", tabId }).catch(() => {});
    };
    stream.getVideoTracks()[0]?.addEventListener("ended", session.ended, { once: true });
    record(session);
  } catch (error) {
    await stop(session);
    throw error;
  }
}

function dataUrl(bytes) {
  const blob = new Blob([bytes], { type: "video/webm" });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function snapshot(tabId) {
  const session = active;
  if (session?.tabId !== tabId) return null;
  const recorder = session.recorder;
  if (recorder?.state !== "recording") return null;
  await new Promise((resolve) => {
    const flushed = () => {
      clearTimeout(timeout);
      recorder.removeEventListener("dataavailable", flushed);
      resolve();
    };
    const timeout = setTimeout(flushed, 300);
    recorder.addEventListener("dataavailable", flushed, { once: true });
    try {
      recorder.requestData();
    } catch {
      flushed();
    }
  });
  await session.reading;
  if (active !== session || session.recorder !== recorder) return null;
  if (session.error) throw new Error(session.error);
  const clip = session.buffer.clip();
  if (!clip) return null;
  const preview = clip.durationMs > previewWindowMs ? session.buffer.clip(previewWindowMs) : null;
  const [video, previewVideo] = await Promise.all([
    dataUrl(clip.bytes),
    preview && dataUrl(preview.bytes),
  ]);
  return { video, durationMs: clip.durationMs, previewVideo };
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.target !== "recorder") return;
  const operations = {
    start: () => start(message),
    status: () => active && { tabId: active.tabId, windowId: active.windowId, origin: active.origin },
    stop: () => stop(),
    snapshot: () => snapshot(message.tabId),
    reset: () => {
      if (active?.tabId === message.tabId) record(active);
    },
  };
  const run = operations[message.operation];
  if (!run) return;
  Promise.resolve().then(run).then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message }),
  );
  return true;
});
