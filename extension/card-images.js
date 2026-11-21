export function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    const site = url.hostname.replace(/^www\./, "");
    let id;
    if (site === "youtu.be") id = url.pathname.slice(1);
    else if (site === "youtube.com" || site === "m.youtube.com") {
      id = url.pathname === "/watch" ? url.searchParams.get("v") : /^\/shorts\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    }
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

export function youtubeThumbnail(id) {
  return "https://i.ytimg.com/vi/" + id + "/mqdefault.jpg";
}

function videoTitle(title) {
  return typeof title === "string" ? title.normalize("NFKC").replace(/\s*[-–|]\s*YouTube\s*$/i, "")
    .toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") : undefined;
}

export async function matchingVideoThumbnail(value, title, signal) {
  const id = youtubeVideoId(value);
  const normalizedTitle = videoTitle(title);
  if (!id || !normalizedTitle) return null;
  const endpoint = new URL("https://www.youtube.com/oembed");
  endpoint.search = new URLSearchParams({ url: "https://www.youtube.com/watch?v=" + id, format: "json" });
  try {
    const response = await fetch(endpoint, {
      credentials: "omit", referrerPolicy: "no-referrer", priority: "low",
      signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
    });
    const data = response.ok ? await response.json() : null;
    return videoTitle(data?.title) === normalizedTitle ? youtubeThumbnail(id) : null;
  } catch {
    return null;
  }
}

export function siteIcon(site) {
  const host = typeof site === "string" ? site.trim().toLowerCase() : "";
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(host) && !/\.(internal|local|localhost|test|example|invalid)$/.test(host)
    ? "https://" + host + "/favicon.ico" : null;
}
