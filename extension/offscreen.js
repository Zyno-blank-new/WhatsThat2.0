import { WebmLookback } from "./webm.js";

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

async function start({ streamId, tabId }) {
  await stop();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: options(streamId),
    video: options(streamId, { maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 }),
  });
  const session = { stream, tabId, buffer: new WebmLookback(), reading: Promise.resolve() };
  active = session;
  try {
    if (stream.getAudioTracks().length) {
      session.audio = new AudioContext();
      session.audio.createMediaStreamSource(stream).connect(session.audio.destination);
      await session.audio.resume();
    }
    const mimeType = "video/webm;codecs=vp8,opus";
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 720_000,
      audioBitsPerSecond: 48_000,
      videoKeyFrameIntervalDuration: 400,
    });
    session.recorder = recorder;
    recorder.ondataavailable = ({ data }) => {
      if (!data.size) return;
      session.reading = session.reading
        .then(async () => session.buffer.append(new Uint8Array(await data.arrayBuffer())))
        .catch((error) => {
          session.error = error.message;
        });
    };
    const ended = () => {
      if (active !== session) return;
      void stop(session);
      void chrome.runtime.sendMessage({ type: "lookback-ended", tabId }).catch(() => {});
    };
    stream.getVideoTracks()[0]?.addEventListener("ended", ended, { once: true });
    recorder.addEventListener("error", ended, { once: true });
    recorder.start(200);
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
  if (active !== session) return null;
  if (session.error) throw new Error(session.error);
  const clip = session.buffer.clip();
  return clip ? { video: await dataUrl(clip.bytes), durationMs: clip.durationMs } : null;
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.target !== "recorder") return;
  const operations = { start: () => start(message), stop: () => stop(), snapshot: () => snapshot(message.tabId) };
  const run = operations[message.operation];
  if (!run) return;
  Promise.resolve().then(run).then(
    (value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message }),
  );
  return true;
});
