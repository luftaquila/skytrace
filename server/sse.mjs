export function createSseHub() {
  const clients = new Set();
  const byIp = new Map();
  let closed = false;

  function sendTo(res, event, data) {
    return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function remove(client) {
    if (!clients.delete(client)) return;
    const count = (byIp.get(client.ip) || 1) - 1;
    if (count > 0) byIp.set(client.ip, count);
    else byIp.delete(client.ip);
    if (!client.res.writableEnded) client.res.end();
  }

  const timer = setInterval(() => {
    for (const client of [...clients]) {
      try {
        if (client.res.destroyed || client.res.writableEnded
          || !sendTo(client.res, "ping", { now: new Date().toISOString() })) remove(client);
      } catch {
        remove(client);
      }
    }
  }, 25000);
  timer.unref?.();

  return {
    add(req, res) {
      if (closed) {
        res.status(503).set("retry-after", "30").json({ ok: false, error: "event stream unavailable" });
        return false;
      }
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      if (clients.size >= 200 || (byIp.get(ip) || 0) >= 6) {
        res.status(503).set("retry-after", "30").json({ ok: false, error: "event stream limit reached" });
        return false;
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      const client = { ip, res };
      clients.add(client);
      byIp.set(ip, (byIp.get(ip) || 0) + 1);
      if (!sendTo(res, "hello", { now: new Date().toISOString() })) remove(client);
      req.once("close", () => remove(client));
      return true;
    },

    broadcast(event, data) {
      for (const client of [...clients]) {
        try {
          if (client.res.destroyed || client.res.writableEnded || !sendTo(client.res, event, data)) {
            remove(client);
          }
        } catch {
          remove(client);
        }
      }
    },

    size() {
      return clients.size;
    },

    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const client of [...clients]) remove(client);
    },
  };
}
