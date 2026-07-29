import assert from "node:assert/strict";
import test from "node:test";

import { createEventStream, parseEventStreamBlock } from "../web/src/event-stream.js";

test("SSE blocks preserve named events and multiline data", () => {
  assert.deepEqual(
    parseEventStreamBlock("event: ingest\r\ndata: one\r\ndata: two"),
    { event: "ingest", data: "one\ntwo" },
  );
  assert.deepEqual(
    parseEventStreamBlock(": keepalive\ndata: hello"),
    { event: "message", data: "hello" },
  );
});

test("fetch-stream SSE handles frame boundaries without native EventSource", async () => {
  const chunks = [
    "event: hello\ndata: {}\n\n",
    "event: ing",
    "est\ndata: {\"changed\":1}\r\n\r\n",
  ];
  let client;
  const events = [];
  let opened = 0;
  const ingested = new Promise((resolve) => {
    client = createEventStream({
      url: "/api/events",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          },
        }),
      }),
      onOpen: () => { opened += 1; },
      onEvent: (event) => {
        events.push(event);
        if (event.event === "ingest") {
          client.stop();
          resolve();
        }
      },
    });
  });

  client.start();
  await ingested;
  assert.equal(opened, 1);
  assert.deepEqual(events, [
    { event: "hello", data: "{}" },
    { event: "ingest", data: "{\"changed\":1}" },
  ]);
});
