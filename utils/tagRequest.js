export function tagRequest(req, gptId, requestId) {
  const tagId = gptId || process.env.GPT_ID || "ARCANOS";
  const suffix = requestId && requestId.trim ? (requestId.trim() || Date.now()) : Date.now();
  const gptTag = `GPT-${tagId}-${suffix}`;
  return { ...req, gptTag };
}
