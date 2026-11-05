import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import WebSocket, { WebSocketServer } from "ws";
import { ElevenLabsDialogueStream } from "./elevenlabs-tts.js";

async function withDialogueServer(
  handleMessage: (socket: WebSocket, message: Record<string, unknown>) => void,
  run: (socketFactory: (url: string, options: { headers: Record<string, string> }) => WebSocket) => Promise<void>,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  server.on("connection", (socket) => {
    socket.on("message", (raw) => handleMessage(socket, JSON.parse(raw.toString()) as Record<string, unknown>));
  });
  try {
    await run((_url, options) => new WebSocket(`ws://127.0.0.1:${address.port}`, options));
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withElevenLabsEnv(run: () => Promise<void>) {
  const keys = ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "ELEVENLABS_MODEL", "ELEVENLABS_FALLBACK_MODEL"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ELEVENLABS_API_KEY: "fixture-key",
    ELEVENLABS_VOICE_ID: "fixture-voice",
    ELEVENLABS_MODEL: "eleven_v4_turbo",
    ELEVENLABS_FALLBACK_MODEL: "eleven_multilingual_v2",
  });
  return run().finally(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("v4 Turbo streams complete sentences through TTD and applies only supported voice settings", async () => {
  await withElevenLabsEnv(async () => {
    const messages: Array<Record<string, unknown>> = [];
    const chunks: Buffer[] = [];
    await withDialogueServer((socket, message) => {
      messages.push(message);
      if (message.close_socket) {
        socket.send(JSON.stringify({ audio: Buffer.from([1, 2, 3]).toString("base64") }));
        socket.send(JSON.stringify({ is_final: true }));
      }
    }, async (socketFactory) => {
      const stream = new ElevenLabsDialogueStream({
        outputFormat: "alaw_8000",
        signal: new AbortController().signal,
        onChunk: (chunk) => chunks.push(chunk),
        voiceProfile: { stability: 0.35, similarity: 0.87, style: 0.6, speed: 0.9, speakerBoost: true },
        socketFactory,
      });
      await stream.append("Guten Tag. Haben Sie kurz Zeit?");
      const result = await stream.finish();
      assert.deepEqual(result, { audioBytes: 3, usedFallback: false });
    });

    assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3]));
    assert.deepEqual(messages[0], {
      voices: ["fixture-voice"],
      voice_settings: { stability: 0.35, similarity_boost: 0.87 },
    });
    assert.deepEqual(messages[1], {
      inputs: [{ text: "Guten Tag. Haben Sie kurz Zeit?", voice_id: "fixture-voice", new_turn: false }],
    });
    assert.deepEqual(messages[2], { flush: true });
    assert.deepEqual(messages[3], { close_socket: true });
  });
});

test("v4 Turbo falls back to HTTP Multilingual v2 only when no dialogue audio arrived", async () => {
  await withElevenLabsEnv(async () => {
    const previousDispatcher = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      let requestedModel = "";
      agent.get("https://api.elevenlabs.io").intercept({
        path: /\/v1\/text-to-speech\/fixture-voice\/stream/,
        method: "POST",
      }).reply((request) => {
        const body = JSON.parse(String(request.body)) as { model_id: string };
        requestedModel = body.model_id;
        return { statusCode: 200, data: Buffer.alloc(320) };
      });

      await withDialogueServer((socket, message) => {
        if (message.voices) socket.send(JSON.stringify({ error: "dialogue model unavailable" }));
      }, async (socketFactory) => {
        const stream = new ElevenLabsDialogueStream({
          outputFormat: "alaw_8000",
          signal: new AbortController().signal,
          onChunk: () => undefined,
          socketFactory,
        });
        await stream.append("Der vollständige Satz wird wiedergegeben.");
        const result = await stream.finish();
        assert.equal(result.audioBytes, 320);
        assert.equal(result.usedFallback, true);
        assert.match(result.error || "", /dialogue model unavailable/);
      });
      assert.equal(requestedModel, "eleven_multilingual_v2");
    } finally {
      await agent.close();
      setGlobalDispatcher(previousDispatcher);
    }
  });
});
