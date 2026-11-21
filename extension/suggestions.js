const vagueLabels = new Set([
  "current scene", "key takeaways", "main idea", "more information",
  "overview", "page summary", "summary", "this moment", "video summary",
  "what happened", "what you saw",
]);

export function chipKey(value) {
  return value.normalize("NFKC").toLowerCase().replace(/(\d),(?=\d)/g, "$1")
    .replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
}

export function normalizeSections(sections, limit, plan = false) {
  if (!Array.isArray(sections)) return [];
  const labels = new Set();
  const questions = new Set();
  const result = [];
  for (const section of sections.slice(0, 4)) {
    const title = typeof section?.title === "string" ? section.title.trim().slice(0, 60) : "";
    if (!title || !Array.isArray(section?.chips)) continue;
    const chips = [];
    for (const entry of section.chips) {
      if (labels.size >= limit) break;
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      const question = typeof entry?.question === "string" ? entry.question.trim() : "";
      if (!label || label.length > 85 || !question || question.length > 240) continue;
      const labelKey = chipKey(label);
      const questionKey = chipKey(question);
      if (!labelKey || !questionKey || vagueLabels.has(labelKey) || labels.has(labelKey) || questions.has(questionKey)) continue;
      labels.add(labelKey);
      questions.add(questionKey);
      const answer = typeof entry.answer === "string" ? entry.answer.trim().slice(0, 420) : "";
      const sourceQuery = typeof entry.sourceQuery === "string" ? entry.sourceQuery.trim().slice(0, 240) : "";
      chips.push({ label, question, ...(answer ? { answer } : {}), ...(sourceQuery ? { sourceQuery } : {}) });
    }
    if (chips.length || plan) {
      const layout = ["chips", "video", "link"].includes(section.layout) ? section.layout : "chips";
      result.push(plan ? { title, layout, chips } : { title, chips });
    }
  }
  return result;
}

export function distinctTopics(sections, previewCount, retainedPreviews, matches) {
  const retained = [...retainedPreviews];
  let index = previewCount;
  return sections.flatMap(({ title, chips }) => {
    const distinct = chips.filter(() => {
      const current = index++;
      if (retained.some((earlier) => matches.has(`same_${earlier}_${current}`))) return false;
      retained.push(current);
      return true;
    });
    return distinct.length ? [{ title, chips: distinct }] : [];
  });
}
