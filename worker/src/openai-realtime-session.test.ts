import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OpenAiRealtimeSession, type RealtimeServerEvent, type RealtimeSocket } from "./openai-realtime-session.js";

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 0;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };

  send(data: string): void { this.sent.push(data); }
  close(code?: number, reason?: string): void { this.closed = { code, reason }; }
  open(): void { this.readyState = 1; this.emit("open"); }
  message(value: unknown): void { this.emit("message", Buffer.from(JSON.stringify(value))); }
}

test("buffers inbound audio until the socket opens", () => {
  const socket = new FakeSocket();
  const session = new OpenAiRealtimeSession({
    apiKey: "test-key",
    model: "test-model",
    onEvent: () => undefined,
    socketFactory: () => socket,
  });
  session.connect();
  session.appendInputAudio("audio-one");
  assert.deepEqual(socket.sent, []);

  socket.open();
  assert.equal(session.isReady(), true);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "input_audio_buffer.append", audio: "audio-one" });
});

test("parses server events and ignores malformed frames", () => {
  const socket = new FakeSocket();
  const events: RealtimeServerEvent[] = [];
  const session = new OpenAiRealtimeSession({
    apiKey: "test-key",
    model: "test-model",
    onEvent: (event) => events.push(event),
    socketFactory: () => socket,
  });
  session.connect();
  socket.open();
  socket.message({ type: "response.created" });
  socket.emit("message", Buffer.from("not-json"));
  assert.deepEqual(events, [{ type: "response.created" }]);
});

test("serializes client events and closes cleanly", () => {
  const socket = new FakeSocket();
  const session = new OpenAiRealtimeSession({
    apiKey: "test-key",
    model: "gpt-realtime-2.1",
    onEvent: () => undefined,
    socketFactory: (url, headers) => {
      assert.match(url, /gpt-realtime-2\.1/);
      assert.equal(headers.Authorization, "Bearer test-key");
      return socket;
    },
  });
  session.connect();
  socket.open();
  assert.equal(session.send({ type: "response.cancel" }), true);
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "response.cancel" });
  session.close(1000, "done");
  assert.deepEqual(socket.closed, { code: 1000, reason: "done" });
});