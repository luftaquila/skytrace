export function createSseHub() {
  const clients = new Set();

  function sendTo(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  return {
    add(req, res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      clients.add(res);
      sendTo(res, "hello", { now: new Date().toISOString() });
      const timer = setInterval(() => sendTo(res, "ping", { now: new Date().toISOString() }), 25000);
      req.on("close", () => {
        clearInterval(timer);
        clients.delete(res);
      });
    },

    broadcast(event, data) {
      for (const res of [...clients]) {
        try {
          sendTo(res, event, data);
        } catch {
          clients.delete(res);
        }
      }
    },

    size() {
      return clients.size;
    },
  };
}
