export function productThumbnail(clip, visual, signal) {
  const { seconds, box } = visual ?? {};
  const duration = clip.durationMs / 1000;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration ||
      !Array.isArray(box) || box.length !== 4 ||
      !box.every((value) => Number.isFinite(value) && value >= 0 && value <= 1000) ||
      box[2] - box[0] < 20 || box[3] - box[1] < 20 || signal.aborted) return Promise.resolve(null);

  const video = document.createElement("video");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(2500)]);
  return new Promise((resolve) => {
    function finish(image = null) {
      video.onloadeddata = video.onseeked = video.onerror = null;
      deadline.removeEventListener("abort", cancel);
      video.removeAttribute("src");
      video.load();
      resolve(image);
    }
    const cancel = () => finish();
    function draw() {
      try {
        const [left, top, right, bottom] = box;
        const x = left * video.videoWidth / 1000;
        const y = top * video.videoHeight / 1000;
        const width = (right - left) * video.videoWidth / 1000;
        const height = (bottom - top) * video.videoHeight / 1000;
        if (width < 12 || height < 12) return finish();
        const scale = Math.min(1, 144 / Math.max(width, height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const context = canvas.getContext("2d");
        if (!context) return finish();
        context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL("image/webp", 0.82));
      } catch {
        finish();
      }
    }
    deadline.addEventListener("abort", cancel, { once: true });
    video.onerror = cancel;
    video.onseeked = draw;
    video.onloadeddata = () => {
      const time = Math.min(seconds, Math.max(0, duration - 0.06));
      if (time <= 0.03) draw();
      else video.currentTime = time;
    };
    video.muted = true;
    video.preload = "auto";
    video.src = clip.video;
  });
}
