export function amazonItemUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        !/^(?:(?:www|m)\.)?amazon\.com$/.test(url.hostname)) return null;
    const item = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(url.pathname);
    return item ? "https://www.amazon.com/dp/" + item[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

export function productPhotoKey(title) {
  if (typeof title !== "string") return "";
  return title.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.sort().join(" ") ?? "";
}
