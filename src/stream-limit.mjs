export async function readResponseBytes(response, maxBytes, { abort = null } = {}) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    abort?.();
    throw Object.assign(new Error("response body too large"), { code: "BODY_TOO_LARGE" });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        abort?.();
        throw Object.assign(new Error("response body too large"), { code: "BODY_TOO_LARGE" });
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseJson(response, maxBytes, options) {
  const bytes = await readResponseBytes(response, maxBytes, options);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON response"), { code: "INVALID_JSON" });
  }
}
