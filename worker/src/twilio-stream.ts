import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { log } from "./log.js";
import { newContext, type CallContext } from "./state.js";
import { openDeepgram, type AsrSession } from "./asr.js";
import { generateReply } from "./llm.js";
import { streamElevenLabsToMulaw, type TtsStreamHandle } from "./tts.js";
import { loadPlaybook, playbookToSystemPrompt } from "./playbook.js";
import { loadBusySlots, busySlotsToPrompt } from "./busy.js";
import { postReport } from "./finalize.js";

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
  let playbookReady: Promise<void> | null = null;
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
    let totalAudioBytes = 0;
    const sendAndCount = (frame: Buffer) => {
      sendMedia(frame);
      totalAudioBytes += frame.length;
    };
    const handle = streamElevenLabsToMulaw(text, (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= FRAME_BYTES) {
        const frame = buffer.subarray(0, FRAME_BYTES);
        buffer = buffer.subarray(FRAME_BYTES);
        sendAndCount(frame);
      }
    });
    currentTts = handle;

    await handle.done;

    if (buffer.length > 0) {
      // Pad final frame with silence (μ-law silence = 0xFF) so Twilio plays it.
      const pad = Buffer.alloc(FRAME_BYTES - buffer.length, 0xff);
      sendAndCount(Buffer.concat([buffer, pad]));
    }

    sendMark("gloria-end");

    // WICHTIG: Twilio puffert Audio. Wenn wir direkt nach dem letzten Frame
    // ws.close() rufen, wird das Audio (z. B. "Auf Wiederhören.") nie
    // ausgespielt. Bei μ-law 8 kHz entspricht 1 Byte 1/8000 Sekunde Audio.
    // Wir warten daher die geschätzte Restspielzeit ab, bevor wir die
    // Sprechen-Phase als beendet markieren.
    if (!handle.aborted) {
      const playoutMs = Math.ceil(totalAudioBytes / 8) + 250; // ~Bytes/8 = ms; + Safety
      await new Promise<void>((resolve) => setTimeout(resolve, playoutMs));
    }

    ctx.speaking = false;
    currentTts = null;
    ctx.transcript.push({ role: "assistant", text, at: Date.now() });
    // Termin-Slot extrahieren – aber NUR aus echten Bestätigungs-Sätzen
    // ("wird am … bei Ihnen sein", "bestätige ich für Sie …", "Termin … ist am …").
    // Bei späterer Änderung wird die Phrase überschrieben.
    const slot = extractConfirmedSlot(text);
    if (slot && slot !== ctx.confirmedSlotPhrase) {
      ctx.confirmedSlotPhrase = slot;
      log.info("turn.slot_locked", { callSid: ctx.callSid, slot });
    }
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

      // Vor der ersten LLM-Antwort kurz auf das Playbook warten (max. 6 s),
      // damit Phase 3+ wirklich mit Playbook-Wissen gefahren wird.
      if (playbookReady && !ctx.playbookPrompt) {
        await Promise.race([
          playbookReady,
          new Promise<void>((resolve) => setTimeout(resolve, 6000)),
        ]);
      }

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
          ownerGesellschaft: params.ownerGesellschaft,
        });
        log.info("call.started", {
          callSid: ctx.callSid,
          streamSid: ctx.streamSid,
          company: ctx.company,
          topic: ctx.topic,
        });

        // Lade Playbook (Fachlichkeit & Gesprächsleitfaden) asynchron, ohne Anruf zu blockieren.
        playbookReady = loadPlaybook({ userId: ctx.userId, topic: ctx.topic }).then((pb) => {
          if (!ctx || !pb) return;
          const promptBlock = playbookToSystemPrompt(pb);
          if (promptBlock) {
            ctx.playbookPrompt = promptBlock;
            log.info("playbook.applied", { topic: pb.topic });
          }
        });

        // Lade bereits belegte Termin-Slots parallel, damit Gloria keine
        // Doppelbelegungen vorschlägt.
        void loadBusySlots({ userId: ctx.userId }).then((slots) => {
          if (!ctx || !slots) return;
          ctx.busySlotsPrompt = busySlotsToPrompt(slots);
          log.info("busy.applied", { count: slots.length });
        });

        asr = openDeepgram({
          onPartial: (text) => {
            if (!ctx) return;
            // Barge-in nur, wenn der Anrufer wirklich substanziell spricht
            // (mind. 3 Worte / 14 Zeichen). Vorher reichten 4 Zeichen, das hat zu
            // Mid-Sentence-Abbruechen gefuehrt (Echo, kurze Fueller wie "hm", "ja").
            if (ctx.speaking && currentTts) {
              const trimmed = text.trim();
              const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
              if (trimmed.length >= 14 && wordCount >= 3) {
                log.info("turn.barge_in", { callSid: ctx.callSid, partial: trimmed });
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
    if (ctx) {
      try {
        await postReport(ctx);
      } catch (error) {
        log.error("finalize.unhandled", {
          error: error instanceof Error ? error.message : String(error),
          callSid: ctx.callSid,
        });
      }
    }
  });

  ws.on("error", (error) => {
    log.error("ws.error", { error: error.message, callSid: ctx?.callSid });
  });
}

// buildOpener wurde entfernt: Gloria spricht erst, nachdem der
// Angerufene sich gemeldet hat (vgl. /api/twilio/voice/process).

/**
 * Extrahiert die bestätigte Termin-Phrase aus Glorias eigener Antwort,
 * sobald sie einen Termin bestätigt (NICHT bei Vorschlägen mit Fragezeichen
 * oder "oder"-Alternativen). Nur echte Bestätigungs-Sätze:
 *   - "wird am ... bei Ihnen sein"
 *   - "bestätige ich für Sie ..."
 *   - "halte ich ... für Sie frei"
 *   - "Ihr Termin ... ist am ..."
 * Erfasst Wochentag + Datum + Uhrzeit als zusammenhängende Phrase.
 */
function extractConfirmedSlot(text: string): string | null {
  // Schließe reine Vorschlagsfragen aus ("oder ... besser passen?", "wäre ... besser?").
  const lower = text.toLowerCase();
  const isProposal =
    /\boder\s+(?:[a-zäöüß]+,\s+)?(?:montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag)/.test(
      lower,
    ) || /\bw[äa]re\s+ihnen\b/.test(lower) || /\bw[üu]rde\s+ihnen\b/.test(lower) ||
    /\bpasst\s+ihnen\b/.test(lower);
  if (isProposal) return null;

  // Bestätigungs-Anker: muss eines dieser Schlüsselwort-Muster enthalten.
  const isConfirmation =
    /\bwird\s+am\b/.test(lower) ||
    /\bbest[äa]tige\s+ich\b/.test(lower) ||
    /\bhalte\s+ich\b/.test(lower) ||
    /\b(?:ihr|der)\s+termin[^.?!]*\bist\s+am\b/.test(lower) ||
    /\bist\s+(?:ihr|der)\s+termin[^.?!]*\bam\b/.test(lower) ||
    /\bdann\s+ist\s+(?:ihr|der)?\s*termin\b/.test(lower) ||
    /\btermin[^.?!]*\bist\s+am\b/.test(lower) ||
    /\bich\s+notiere\b/.test(lower) ||
    /\bich\s+trage\s+(?:ihn|den\s+termin)\s+ein\b/.test(lower);
  if (!isConfirmation) return null;

  const re = /\b(?:am\s+)?((?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)[^.?!]*?\bum\s+[a-zäöüß]+\s+Uhr(?:\s+[a-zäöüß]+)?)/i;
  const m = re.exec(text);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ");
}
