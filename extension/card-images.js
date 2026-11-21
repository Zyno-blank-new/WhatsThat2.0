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

function placeWords(value) {
  return new Set(value.normalize("NFKD").toLowerCase().replace(/\p{Mark}/gu, "")
    .match(/[\p{L}\p{N}]+/gu)?.filter((word) => !["a", "in", "of", "the"].includes(word))
    .map((word) => word.length > 4 ? word.replace(/s$/, "") : word));
}

export async function landmarkPhoto(subject, signal, fetcher = fetch) {
  const words = placeWords(subject);
  if (!words.size) return null;
  const endpoint = new URL("https://en.wikipedia.org/w/api.php");
  endpoint.search = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search",
    gsrsearch: subject, gsrnamespace: "0", gsrlimit: "4", prop: "pageimages",
    piprop: "thumbnail|name", pithumbsize: "240", pilicense: "free", origin: "*",
  });
  try {
    const response = await fetcher(endpoint, {
      credentials: "omit", referrerPolicy: "no-referrer", priority: "low",
      headers: { "Api-User-Agent": "WhatsThat/2.0 (https://github.com/Zyno-blank-new/WhatsThat2.0)" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const pages = data.query?.pages ?? [];
    for (const page of pages.sort((first, second) => first.index - second.index)) {
      const title = placeWords(page.title);
      const shared = [...words].filter((word) => title.has(word)).length;
      if (shared < Math.ceil(words.size * 0.7) || !page.pageimage || !page.thumbnail?.source) continue;
      const image = new URL(page.thumbnail.source);
      if (!["https://upload.wikimedia.org", "https://thumb.wikimedia.org"].includes(image.origin) ||
          !image.pathname.startsWith("/wikipedia/commons/")) continue;
      return {
        src: image.href,
        credit: "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(page.pageimage.replaceAll(" ", "_")),
      };
    }
  } catch {
    return null;
  }
  return null;
}
