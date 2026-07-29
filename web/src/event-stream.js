export function parseEventStreamBlock(block) {
  let event = "message";
  const data = [];
  for (const line of String(block || "").split(/\r\n|\r|\n/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value || "message";
    else if (field === "data") data.push(value);
  }
  return { event, data: data.join("\n") };
}

function nextBlock(buffer) {
  const match = /\r\n\r\n|\r\r|\n\n/.exec(buffer);
  if (!match) return null;
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

export function createEventStream({
  url,
  onOpen,
  onEvent,
  onDisconnect,
  fetchImpl = fetch,
  retryMs = 5000,
}) {
  let stopped = true;
  let generation = 0;
  let controller = null;
  let retryTimer = null;

  async function consume(activeGeneration) {
    controller = new AbortController();
    let retryAfterMs = retryMs;
    let disconnectError = null;
    try {
      const response = await fetchImpl(url, {
        headers: { accept: "text/event-stream" },
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryAfterMs = retryAfter * 1000;
        throw Object.assign(new Error(`event stream returned ${response.status}`), {
          status: response.status,
        });
      }
      if (stopped || activeGeneration !== generation) return;
      onOpen?.();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!stopped && activeGeneration === generation) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let frame;
          while ((frame = nextBlock(buffer))) {
            buffer = frame.rest;
            const parsed = parseEventStreamBlock(frame.block);
            if (parsed.data || parsed.event !== "message") onEvent?.(parsed);
          }
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (
        stopped
        || activeGeneration !== generation
        || controller?.signal.aborted
        || error?.name === "AbortError"
      ) return;
      disconnectError = error;
    }
    if (stopped || activeGeneration !== generation) return;
    onDisconnect?.(disconnectError);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void consume(activeGeneration);
    }, retryAfterMs);
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      generation += 1;
      void consume(generation);
    },
    stop() {
      stopped = true;
      generation += 1;
      controller?.abort();
      controller = null;
      if (retryTimer != null) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
