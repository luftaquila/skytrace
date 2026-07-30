import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseHub } from "../server/sse.mjs";

function request(ip) {
  const req = new EventEmitter();
  req.ip = ip;
  req.socket = { remoteAddress: ip };
  return req;
}

function response(writeResult = true) {
  return {
    destroyed: false,
    writableEnded: false,
    statusCode: null,
    headers: {},
    body: null,
    writes: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[String(name).toLowerCase()] = String(value);
      return this;
    },
    json(body) {
      this.body = body;
      this.writableEnded = true;
      return this;
    },
    writeHead(code, headers) {
      this.statusCode = code;
      for (const [name, value] of Object.entries(headers)) this.set(name, value);
    },
    flushHeaders() {},
    write(chunk) {
      this.writes.push(chunk);
      return writeResult;
    },
    end() {
      this.writableEnded = true;
    },
  };
}

test("SSE enforces per-IP and global connection limits and drains on close", () => {
  const hub = createSseHub();
  const active = [];
  for (let index = 0; index < 6; index += 1) {
    const res = response();
    assert.equal(hub.add(request("192.0.2.1"), res), true);
    active.push(res);
  }
  const seventh = response();
  assert.equal(hub.add(request("192.0.2.1"), seventh), false);
  assert.equal(seventh.statusCode, 503);
  assert.equal(seventh.headers["retry-after"], "30");

  for (let index = 0; index < 194; index += 1) {
    const res = response();
    assert.equal(hub.add(request(`198.51.100.${index}`), res), true);
    active.push(res);
  }
  assert.equal(hub.size(), 200);
  const overflow = response();
  assert.equal(hub.add(request("203.0.113.1"), overflow), false);
  assert.equal(overflow.statusCode, 503);

  hub.close();
  assert.equal(hub.size(), 0);
  assert.equal(active.every((res) => res.writableEnded), true);
  const afterClose = response();
  assert.equal(hub.add(request("203.0.113.2"), afterClose), false);
  assert.equal(afterClose.statusCode, 503);
});

test("SSE immediately drops a client that applies write backpressure", () => {
  const hub = createSseHub();
  const res = response(false);
  assert.equal(hub.add(request("192.0.2.5"), res), true);
  assert.equal(hub.size(), 0);
  assert.equal(res.writableEnded, true);
  hub.close();
});
