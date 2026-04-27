import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { log } from "./log.js";
import { newContext, type CallContext } from "./state.js";
import { openDeepgram, type AsrSession } from "./asr.js";
import { generateReply } from "./llm.js";
import { streamElevenLabsToMulaw, type TtsStreamHandle } from "./tts.js";
import { loadPlaybook, playbookToSystemPrompt } from "./playbook.js";

/** Twilio Media Streams send frames in 20 ms chunks of μ-law 8 kHz (160 bytes per frame). */
const FRAME_BYTES = 160;

type TwilioInbound =
  | { event: "connected"; protocol?: string; version?: string }
  | {
      event: "start";
      start: {
        streamSid: string;
        callSid: string;
        accountSid: string;
        tracks: string[];
        mediaFormat: { encoding: string; sampleRate: number; channels: number };
        customParameters?: Record<string, string>;
      };
      streamSid: string;
    }
  | {
      event: "media";
      streamSid: string;
      media: {
        track: "inbound" | "outbound";
        chunk: string;
        timestamp: string;
        payload: string;
      };
    }
  | { event: "mark"; streamSid: string; mark: { name: string } }
  | { event: "stop"; streamSid: string };

export async function handleTwilioStream(ws: WebSocket, _req: IncomingMessage): Promise<void> {
  let ctx: CallContext | null = null;
  let asr: AsrSession | null = null;
  let pendingTurn = false;
  let currentTts: TtsStreamHandle | null = null;
  let inboundFrameCount = 0;

  const sendMedia = (mulaw: Buffer) => {
    if (!ctx || ws.readyState !== ws.OPEN) return;
    const payload = mulaw.toString("base64");
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: ctx.streamSid,
        media: { payload },
      }),
    );
  };

  const sendMark = (name: string) => {
    if (!ctx || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ event: "mark", streamSid: ctx.streamSid, mark: { name } }));
  };

  const speak = async (text: string) => {
    if (!ctx) return;
    if (!text.trim()) return;
    log.info("turn.gloria_says", { callSid: ctx.callSid, text });

    // Cancel any in-flight TTS first (barge-in safety).
    if (currentTts) {
      currentTts.abort();
      currentTts = null;
    }

    ctx.speaking = true;
    ctx.userBytesWhileSpeaking = 0;

    let buffer = Buffer.alloc(0);
    const handle = streamElevenLabsToMulaw(text, (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= FRAME_BYTES) {
        const frame = buffer.subarray(0, FRAME_BYTES);
        buffer = buffer.subarray(FRAME_BYTES);
        sendMedia(frame);
      }
    });
    currentTts = handle;

    await handle.done;

    if (buffer.length > 0) {
      // Pad final frame with silence (μ-law silence = 0xFF) so Twilio plays it.
      const pad = Buffer.alloc(FRAME_BYTES - buffer.length, 0xff);
      sendMedia(Buffer.concat([buffer, pad]));
    }

    sendMark("gloria-end");
    ctx.speaking = false;
    currentTts = null;
    ctx.transcript.push({ role: "assistant", text, at: Date.now() });
  };

  const handleUserUtterance = async (userText: string) => {
    if (!ctx) return;
    if (pendingTurn) {
      // Still working on the previous turn — append to transcript only.
      ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
      return;
    }
    pendingTurn = true;
    try {
      ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
      log.info("turn.user_said", { callSid: ctx.callSid, text: userText });

      const reply = await generateReply(ctx, userText);
      await speak(reply.reply);

      if (reply.hangup) {
        log.info("turn.hangup", { callSid: ctx.callSid });
        try {
          ws.close(1000, "hangup");
        } catch {
          /* ignore */
        }
      }
    } finally {
      pendingTurn = false;
    }
  };

  ws.on("message", async (raw) => {
    let frame: TwilioInbound;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as TwilioInbound;
    } catch {
      return;
    }

    switch (frame.event) {
      case "connected": {
        log.info("ws.connected", { protocol: frame.protocol });
        break;
      }
      case "start": {
        const params = frame.start.customParameters || {};
        ctx = newContext({
          callSid: frame.start.callSid,
          streamSid: frame.streamSid,
          userId: params.userId,
          leadId: params.leadId,
          company: params.company,
          contactName: params.contactName,
          topic: params.topic,
          ownerRealName: params.ownerRealName,
          ownerCompanyName: params.ownerCompanyName,
        });
        log.info("call.started", {
          callSid: ctx.callSid,
          streamSid: ctx.streamSid,
          company: ctx.company,
          topic: ctx.topic,
        });

        // Lade Playbook (Fachlichkeit & Gesprächsleitfaden) asynchron, ohne Anruf zu blockieren.
        void loadPlaybook({ userId: ctx.userId, topic: ctx.topic }).then((pb) => {
          if (!ctx || !pb) return;
          const promptBlock = playbookToSystemPrompt(pb);
          if (promptBlock) {
            ctx.playbookPrompt = promptBlock;
            log.info("playbook.applied", { topic: pb.topic });
          }
        });

        asr = openDeepgram({
          onPartial: (text) => {
            if (!ctx) return;
            if (ctx.speaking && text.length > 4) {
              // Barge-in: user started speaking while Gloria was talking.
              if (currentTts) {
                log.info("turn.barge_in", { callSid: ctx.callSid });
                currentTts.abort();
                currentTts = null;
                ctx.speaking = false;
              }
            }
          },
          onFinal: (text) => {
            void handleUserUtterance(text);
          },
          onUtteranceEnd: () => {
            // Reserved for future use (e.g. silence-driven prompts).
          },
          onError: (error) => {
            log.error("asr.session_error", { error: error.message });
          },
        });

        // Gloria wartet bewusst, bis der Angerufene sich gemeldet hat
        // ("Praxis Müller", "Hallo, Schmidt"). Erst danach reagiert das LLM
        // mit dem passenden Opener (Empfang vs. Entscheider).
        break;
      }
      case "media": {
        if (!ctx || !asr) return;
        if (frame.media.track !== "inbound") return;
        inboundFrameCount += 1;
        const buf = Buffer.from(frame.media.payload, "base64");
        asr.send(buf);
        if (ctx.speaking) {
          ctx.userBytesWhileSpeaking += buf.length;
        }
        break;
      }
      case "mark": {
        if (frame.mark.name === "gloria-end" && ctx) {
          ctx.speaking = false;
        }
        break;
      }
      case "stop": {
        log.info("call.stopped", { callSid: ctx?.callSid, frames: inboundFrameCount });
        try {
          await asr?.finish();
        } catch {
          /* ignore */
        }
        try {
          ws.close(1000, "stop");
        } catch {
          /* ignore */
        }
        break;
      }
    }
  });

  ws.on("close", async (code, reason) => {
    log.info("ws.closed", { code, reason: reason.toString(), callSid: ctx?.callSid });
    if (currentTts) currentTts.abort();
    try {
      await asr?.finish();
    } catch {
      /* ignore */
    }
    // TODO: persist final transcript / outcome to APP_BASE_URL.
  });

  ws.on("error", (error) => {
    log.error("ws.error", { error: error.message, callSid: ctx?.callSid });
  });
}

// buildOpener wurde entfernt: Gloria spricht erst, nachdem der
// Angerufene sich gemeldet hat (vgl. /api/twilio/voice/process).
