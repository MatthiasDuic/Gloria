import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { log } from "./log.js";
import { newContext, type CallContext } from "./state.js";
import { openAsr, type AsrSession } from "./asr.js";
import { streamReply, prewarmOpenAi } from "./llm.js";
import { streamElevenLabsToMulaw, prewarmElevenLabs, type TtsStreamHandle } from "./tts.js";
import { loadPlaybook, playbookToSystemPrompt } from "./playbook.js";
import { loadBusySlots, busySlotsToPrompt, computeFreeSlots, freeSlotsToPrompt } from "./busy.js";
import { postReport } from "./finalize.js";
import { classifyInboundSpeech } from "./call-classification.js";
import { observeAssistantFlowState, observeUserFlowState } from "./topic-policy.js";

/** Telnyx PCMU 8 kHz uses 20 ms chunks (160 bytes per frame). */
const FRAME_BYTES = 160;
const MULAW_SILENCE_BYTE = 0xff;
const MULAW_FRAME_SAMPLES = 160;

type TelnyxInbound =
  | { event: "connected"; version?: string }
  | {
      event: "start";
      start: {
        call_control_id: string;
        call_session_id?: string;
        from?: string;
        to?: string;
        client_state?: string;
        media_format?: { encoding?: string; sample_rate?: number; channels?: number };
      };
      stream_id: string;
      sequence_number?: string;
    }
  | {
      event: "media";
      stream_id: string;
      sequence_number?: string;
      media: {
        track: "inbound" | "outbound" | "inbound_track" | "outbound_track";
        chunk: string;
        timestamp: string;
        payload: string;
      };
    }
  | { event: "mark"; stream_id: string; mark: { name: string } }
  | { event: "stop"; stream_id: string }
  | { event: "dtmf"; stream_id: string; dtmf: { digit: string } }
  | { event: "error"; stream_id?: string; payload?: { code?: number; title?: string; detail?: string } };

type DecodedClientState = {
  company?: string;
  contactName?: string;
  leadNote?: string;
  topic?: string;
  leadId?: string;
  userId?: string;
  phoneNumberId?: string;
  ownerRealName?: string;
  ownerCompanyName?: string;
  ownerGesellschaft?: string;
  voiceId?: string;
  previousSummary?: string;
  isCallback?: number;
};

function decodeClientState(raw?: string): DecodedClientState {
  if (!raw) return {};
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    return JSON.parse(json) as DecodedClientState;
  } catch {
    return {};
  }
}

function mulaw8kToPcm16k(mulaw: Buffer): Buffer {
  const output = Buffer.alloc(mulaw.length * 4);
  let offset = 0;
  for (const byte of mulaw) {
    const sample = decodeMulawSample(byte);
    output.writeInt16LE(sample, offset);
    output.writeInt16LE(sample, offset + 2);
    offset += 4;
  }
  return output;
}

function alaw8kToPcm16k(alaw: Buffer): Buffer {
  const output = Buffer.alloc(alaw.length * 4);
  let offset = 0;
  for (const byte of alaw) {
    const sample = decodeAlawSample(byte);
    output.writeInt16LE(sample, offset);
    output.writeInt16LE(sample, offset + 2);
    offset += 4;
  }
  return output;
}

function decodeMulawSample(byte: number): number {
  let value = ~byte & 0xff;
  let magnitude = ((value & 0x0f) << 3) + 0x84;
  magnitude <<= (value & 0x70) >> 4;
  return (value & 0x80) !== 0 ? 0x84 - magnitude : magnitude - 0x84;
}

function encodeMulawSample(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;

  let pcm = Math.max(-32768, Math.min(32767, sample));
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }
  if (pcm > CLIP) pcm = CLIP;

  pcm += BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeAlawSample(byte: number): number {
  let value = byte ^ 0x55;
  let t = (value & 0x0f) << 4;
  const seg = (value & 0x70) >> 4;
  switch (seg) {
    case 0:
      t += 8;
      break;
    case 1:
      t += 0x108;
      break;
    default:
      t += 0x108;
      t <<= seg - 1;
      break;
  }
  return (value & 0x80) !== 0 ? t : -t;
}

function encodeAlawSample(sample: number): number {
  let pcm = Math.max(-32768, Math.min(32767, sample));
  let sign = 0x80;
  if (pcm < 0) {
    sign = 0x00;
    pcm = -pcm - 1;
  }

  let exponent = 7;
  for (let expMask = 0x4000; (pcm & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent -= 1;
  }

  const mantissa = exponent === 0 ? (pcm >> 4) & 0x0f : (pcm >> (exponent + 3)) & 0x0f;
  const alaw = sign | (exponent << 4) | mantissa;
  return alaw ^ 0x55;
}

function mulaw8kToAlaw8k(mulaw: Buffer): Buffer {
  const output = Buffer.allocUnsafe(mulaw.length);
  for (let i = 0; i < mulaw.length; i += 1) {
    const pcm = decodeMulawSample(mulaw[i]);
    output[i] = encodeAlawSample(pcm);
  }
  return output;
}

function smoothMulawFrame(
  frame: Buffer,
  options: { fadeIn?: boolean; fadeOut?: boolean; rampSamples?: number },
): Buffer {
  if (!options.fadeIn && !options.fadeOut) return frame;
  if (frame.length === 0) return frame;

  const out = Buffer.from(frame);
  const sampleCount = Math.min(frame.length, MULAW_FRAME_SAMPLES);
  const ramp = Math.max(8, Math.min(options.rampSamples ?? 32, sampleCount));

  if (options.fadeIn) {
    for (let i = 0; i < ramp; i += 1) {
      const gain = i / ramp;
      const pcm = decodeMulawSample(out[i]);
      out[i] = encodeMulawSample(Math.round(pcm * gain));
    }
  }

  if (options.fadeOut) {
    for (let i = 0; i < ramp; i += 1) {
      const index = sampleCount - 1 - i;
      const gain = i / ramp;
      const pcm = decodeMulawSample(out[index]);
      out[index] = encodeMulawSample(Math.round(pcm * gain));
    }
  }

  return out;
}

function normalizeInboundAudio(audio: Buffer, encoding?: string, sampleRate?: number): Buffer {
  const normalizedEncoding = (encoding || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const isLinear16 =
    normalizedEncoding === "L16" ||
    normalizedEncoding === "LINEAR16" ||
    normalizedEncoding.startsWith("L16") ||
    normalizedEncoding.includes("LINEAR16");
  if (isLinear16) {
    return audio;
  }
  const isMulaw =
    normalizedEncoding === "PCMU" ||
    normalizedEncoding === "MULAW" ||
    normalizedEncoding.includes("PCMU") ||
    normalizedEncoding.includes("MULAW") ||
    normalizedEncoding.includes("G711ULAW");
  if (isMulaw) {
    return sampleRate === 16000 ? audio : mulaw8kToPcm16k(audio);
  }
  const isAlaw =
    normalizedEncoding === "PCMA" ||
    normalizedEncoding === "ALAW" ||
    normalizedEncoding.includes("PCMA") ||
    normalizedEncoding.includes("ALAW") ||
    normalizedEncoding.includes("G711ALAW");
  if (isAlaw) {
    return sampleRate === 16000 ? audio : alaw8kToPcm16k(audio);
  }
  // Defensive fallback: when Telnyx omits/changes encoding labels,
  // prefer telephone-safe assumption (8 kHz mu-law) over returning
  // undecoded bytes into Deepgram.
  if (!sampleRate || sampleRate <= 8000) {
    return mulaw8kToPcm16k(audio);
  }
  return audio;
}

function normalizeOutboundAudio(audio: Buffer, encoding?: string): Buffer {
  const normalizedEncoding = (encoding || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const isAlaw =
    normalizedEncoding === "PCMA" ||
    normalizedEncoding === "ALAW" ||
    normalizedEncoding.includes("PCMA") ||
    normalizedEncoding.includes("ALAW") ||
    normalizedEncoding.includes("G711ALAW");

  if (isAlaw) {
    return mulaw8kToAlaw8k(audio);
  }
  return audio;
}

function detectTelephonyCodec(encoding?: string): "PCMA" | "PCMU" | undefined {
  const normalized = (encoding || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (
    normalized === "PCMA" ||
    normalized === "ALAW" ||
    normalized.includes("PCMA") ||
    normalized.includes("ALAW") ||
    normalized.includes("G711ALAW")
  ) {
    return "PCMA";
  }

  if (
    normalized === "PCMU" ||
    normalized === "MULAW" ||
    normalized.includes("PCMU") ||
    normalized.includes("MULAW") ||
    normalized.includes("G711ULAW")
  ) {
    return "PCMU";
  }

  return undefined;
}

export function shouldInterruptOnPartialSpeech(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const compact = trimmed.replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return false;

  const words = compact.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return false;

  const normalized = compact.toLowerCase();
  if (/^(?:ja|nein|okay|ok|hm+|mhm+|genau|also|gut|aha|danke|tschüss|tschuess|hallo|moin|guten tag|guten morgen|guten abend|bitte)(?:\s|$)/i.test(normalized)) {
    return false;
  }
  if (/^(?:ja|nein)\s+(?:danke|bitte|gern|klar|okay|ok)\b/i.test(normalized)) {
    return false;
  }
  if (/^(?:ja|nein|okay|ok|hm+|mhm+|also|genau)\s*$/i.test(normalized)) {
    return false;
  }
  if (words.length <= 2 && !/[?]/.test(trimmed)) {
    return false;
  }

  return trimmed.length >= 6 || /[?]/.test(trimmed) || words.some((word) => word.length >= 4);
}

export async function handleTelnyxStream(ws: WebSocket, _req: IncomingMessage): Promise<void> {
  let ctx: CallContext | null = null;
  let asr: AsrSession | null = null;
  let pendingTurn = false;
  let currentTts: TtsStreamHandle | null = null;
  let playbookReady: Promise<void> | null = null;
  let silenceOpenerTimer: NodeJS.Timeout | null = null;
  let inboundFrameCount = 0;
  let inboundEncoding = "PCMU";
  let outboundEncoding = (process.env.TELNYX_STREAM_BIDIRECTIONAL_CODEC || "PCMA").trim().toUpperCase();
  let inboundSampleRate = 8000;
  let pendingUserFinals: string[] = [];
  let pendingUtterancesDuringTurn: string[] = [];
  let userFinalCoalesceTimer: NodeJS.Timeout | null = null;

  const userFinalCoalesceMs = Math.max(
    140,
    Number.parseInt(process.env.ASR_FINAL_COALESCE_MS || "520", 10),
  );
  const utteranceEndGraceMs = Math.max(
    90,
    Number.parseInt(process.env.ASR_UTTERANCE_END_GRACE_MS || "320", 10),
  );

  const clearSilenceOpenerTimer = () => {
    if (!silenceOpenerTimer) return;
    clearTimeout(silenceOpenerTimer);
    silenceOpenerTimer = null;
  };

  const clearUserFinalCoalesceTimer = () => {
    if (!userFinalCoalesceTimer) return;
    clearTimeout(userFinalCoalesceTimer);
    userFinalCoalesceTimer = null;
  };

  const flushUserFinals = () => {
    clearUserFinalCoalesceTimer();
    const merged = pendingUserFinals
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pendingUserFinals = [];
    if (!merged) return;
    void handleUserUtterance(merged);
  };

  const queueUserFinal = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    pendingUserFinals.push(trimmed);
    clearUserFinalCoalesceTimer();
    userFinalCoalesceTimer = setTimeout(flushUserFinals, userFinalCoalesceMs);
  };

  const nudgeUserFinalFlush = () => {
    if (pendingUserFinals.length === 0) return;
    clearUserFinalCoalesceTimer();
    const merged = pendingUserFinals.join(" ").trim();
    const wordCount = merged.split(/\s+/).filter(Boolean).length;
    // Kurze Fragmente wie "ja" werden am Telefon häufig direkt fortgesetzt
    // ("ja, worum geht es?"). Ein wenig mehr Grace verhindert vorschnelle
    // Antworten, ohne normale vollständige Sätze auszubremsen.
    const graceMs =
      wordCount <= 2
        ? Math.max(utteranceEndGraceMs, 520)
        : wordCount <= 5
          ? Math.max(utteranceEndGraceMs, 400)
          : utteranceEndGraceMs;
    userFinalCoalesceTimer = setTimeout(flushUserFinals, graceMs);
  };

  const sendMedia = (audio: Buffer) => {
    if (!ctx || ws.readyState !== ws.OPEN) return;
    const encoded = normalizeOutboundAudio(audio, outboundEncoding);
    const payload = encoded.toString("base64");
    ws.send(
      JSON.stringify({
        event: "media",
        stream_id: ctx.streamSid,
        media: { payload },
      }),
    );
  };

  const sendMark = (name: string) => {
    if (!ctx || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ event: "mark", stream_id: ctx.streamSid, mark: { name } }));
  };

  const clearOutboundAudio = () => {
    if (!ctx || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ event: "clear", stream_id: ctx.streamSid }));
  };

  const speak = async (text: string) => {
    if (!ctx) return;
    if (!text.trim()) return;
    log.info("turn.gloria_says", { callSid: ctx.callSid, text });

    // Reaktionszeit = Zeit zwischen letztem user-final und Start des TTS-Streams.
    const speakStartedAt = Date.now();
    const latencyMs =
      ctx.lastUserFinalAt && speakStartedAt > ctx.lastUserFinalAt
        ? speakStartedAt - ctx.lastUserFinalAt
        : undefined;
    if (latencyMs !== undefined) {
      log.info("turn.reaction_time", { callSid: ctx.callSid, ms: latencyMs });
    }

    // Cancel any in-flight TTS first (barge-in safety).
    if (currentTts) {
      currentTts.abort();
      currentTts = null;
    }

    ctx.speaking = true;
    ctx.userBytesWhileSpeaking = 0;

    let buffer = Buffer.alloc(0);
    let totalAudioBytes = 0;
    let firstFrameSent = false;
    const sendAndCount = (frame: Buffer) => {
      // 20 ms Stille vor dem ersten Frame verhindert den Klick-Artefakt
      // beim abrupten Übergang von Stille zu Audio.
      if (!firstFrameSent) {
        sendMedia(Buffer.alloc(FRAME_BYTES, 0xff));
        sendMedia(Buffer.alloc(FRAME_BYTES, 0xff));
        firstFrameSent = true;
      }
      sendMedia(frame);
      totalAudioBytes += frame.length;
    };
    const handle = streamElevenLabsToMulaw(
      text,
      (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
          sendAndCount(frame);
        }
      },
      ctx.voiceId,
      ctx.voiceProfile,
    );
    currentTts = handle;

    await handle.done;

    if (buffer.length > 0) {
      // Pad final frame with mu-law silence so Telnyx can play the trailing fragment cleanly.
      const pad = Buffer.alloc(FRAME_BYTES - buffer.length, 0xff);
      sendAndCount(Buffer.concat([buffer, pad]));
    }

    sendMark("gloria-end");

    // WICHTIG: Telnyx puffert Audio. Wenn wir direkt nach dem letzten Frame
    // ws.close() rufen, wird das Audio (z. B. "Auf Wiederhören.") nie
    // ausgespielt. Bei PCMU 8 kHz entspricht 1 Byte 1/8000 Sekunde Audio.
    // Wir warten daher die geschätzte Restspielzeit ab, bevor wir die
    // Sprechen-Phase als beendet markieren.
    if (!handle.aborted) {
      const playoutMs = Math.ceil(totalAudioBytes / 8) + 120;
      await new Promise<void>((resolve) => setTimeout(resolve, playoutMs));
    }

    ctx.speaking = false;
    currentTts = null;
    ctx.transcript.push({ role: "assistant", text, at: Date.now(), latencyMs });
    ctx.flow = observeAssistantFlowState(ctx.flow, text);
    // Termin-Slot extrahieren – nur aus echten Bestätigungs-Sätzen
    // ("wird am … bei Ihnen sein", "bestätige ich für Sie …", "Termin … ist am …",
    // "notiere ich …" / "ich notiere …").
    // WICHTIG: Sobald ein Slot gelockt ist, NICHT mehr überschreiben – sonst
    // kann eine spätere halluzinierte Zusammenfassung den korrekten Slot kapern.
    if (!ctx.confirmedSlotPhrase) {
      const slot = extractConfirmedSlot(text);
      if (slot) {
        ctx.confirmedSlotPhrase = slot;
        log.info("turn.slot_locked", { callSid: ctx.callSid, slot });
      }
    }
  };

  /**
   * Spricht die LLM-Antwort progressiv satzweise, um die Reaktionszeit
   * deutlich zu senken. Segmentgrenzen werden durch kurze Rampen geglättet,
   * um Klick-Artefakte beim Wechsel zu minimieren.
   */
  const streamAndSpeak = async (userText: string): Promise<{ reply: string; hangup: boolean; transfer: boolean }> => {
    if (!ctx) return { reply: "", hangup: false, transfer: false };
    const callSidForTurn = ctx.callSid;
    const slotWasConfirmedBeforeTurn = Boolean(ctx.confirmedSlotPhrase);
    const turnStartedAt = Date.now();

    if (currentTts) {
      currentTts.abort();
      currentTts = null;
    }
    ctx.speaking = false;
    ctx.userBytesWhileSpeaking = 0;

    const collectedSegments: string[] = [];
    const segmentQueue: string[] = [];
    let result: { reply: string; hangup: boolean; transfer: boolean } = {
      reply: "",
      hangup: false,
      transfer: false,
    };
    let llmDone = false;
    let stopPlayback = false;
    let resolveQueueWait: (() => void) | null = null;
    let queuedSentenceCount = 0;
    let firstSentenceQueuedAt: number | undefined;
    const firstAudioSloMs = Math.max(
      1200,
      Number.parseInt(process.env.TURN_FIRST_AUDIO_SLO_MS || "2400", 10),
    );
    let bridgeInjected = false;

    const wakeQueue = () => {
      if (!resolveQueueWait) return;
      const resolve = resolveQueueWait;
      resolveQueueWait = null;
      resolve();
    };

    const waitForQueue = async (): Promise<void> =>
      new Promise<void>((resolve) => {
        resolveQueueWait = resolve;
      });

    let firstAudioAt: number | undefined;
    let totalAudioBytes = 0;

    const audioSloTimer = setTimeout(() => {
      if (firstAudioAt !== undefined || llmDone || stopPlayback || bridgeInjected) return;
      if (queuedSentenceCount > 0) return;
      bridgeInjected = true;
      segmentQueue.push("Einen kurzen Moment, ich bin direkt bei Ihnen.");
      wakeQueue();
      log.warn("turn.audio_slo_bridge", { callSid: callSidForTurn, ms: firstAudioSloMs });
    }, firstAudioSloMs);

    let firstFrameOfTurn = true;
    const speakSegment = async (segmentText: string): Promise<void> => {
      if (!ctx || stopPlayback) return;
      if (!segmentText.trim()) return;

      log.info("turn.gloria_segment", { callSid: ctx.callSid, text: segmentText });
      collectedSegments.push(segmentText);

      let buffer = Buffer.alloc(0);
      let segmentHadAudio = false;
      let lastFrame: Buffer | null = null;

      const flushFrame = (frame: Buffer, isSegmentLastFrame: boolean) => {
        if (firstAudioAt === undefined) {
          if (!ctx) return;
          // Ein kurzer Pre-Roll reicht aus und spart 20 ms gegenüber 2 Frames.
          sendMedia(Buffer.alloc(FRAME_BYTES, MULAW_SILENCE_BYTE));
          firstAudioAt = Date.now();
          ctx.speaking = true;
        }

        let out = frame;
        if (firstFrameOfTurn) {
          out = smoothMulawFrame(out, { fadeIn: true });
          firstFrameOfTurn = false;
        }
        if (isSegmentLastFrame) {
          out = smoothMulawFrame(out, { fadeOut: true });
        }

        sendMedia(out);
        totalAudioBytes += out.length;
        segmentHadAudio = true;
      };

      const handle = streamElevenLabsToMulaw(
        segmentText,
        (chunk) => {
          buffer = Buffer.concat([buffer, chunk]);
          while (buffer.length >= FRAME_BYTES) {
            const frame = buffer.subarray(0, FRAME_BYTES);
            buffer = buffer.subarray(FRAME_BYTES);
            if (lastFrame) {
              flushFrame(lastFrame, false);
            }
            lastFrame = Buffer.from(frame);
          }
        },
        ctx.voiceId,
        ctx.voiceProfile,
      );

      currentTts = handle;
      await handle.done;

      if (handle.aborted) {
        stopPlayback = true;
        currentTts = null;
        segmentQueue.length = 0;
        return;
      }

      if (buffer.length > 0) {
        const pad = Buffer.alloc(FRAME_BYTES - buffer.length, MULAW_SILENCE_BYTE);
        const padded = Buffer.concat([buffer, pad]);
        if (lastFrame) {
          flushFrame(lastFrame, false);
        }
        flushFrame(padded, true);
        lastFrame = null;
      } else if (lastFrame) {
        flushFrame(lastFrame, true);
        lastFrame = null;
      }

      currentTts = null;
      if (!segmentHadAudio) {
        log.warn("turn.segment_empty_audio", { callSid: ctx.callSid });
      }

      const pauseMs = Math.max(0, ctx.voiceProfile.segmentPauseMs || 0);
      if (!stopPlayback && pauseMs > 0 && (segmentQueue.length > 0 || !llmDone)) {
        await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
      }
    };

    const playbackPump = (async () => {
      while (!stopPlayback) {
        const next = segmentQueue.shift();
        if (next) {
          await speakSegment(next);
          continue;
        }
        if (llmDone) {
          break;
        }
        await waitForQueue();
      }
    })();

    result = await streamReply(ctx, userText, (sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed || stopPlayback) return;
      queuedSentenceCount += 1;
      if (!firstSentenceQueuedAt) {
        firstSentenceQueuedAt = Date.now();
      }
      segmentQueue.push(trimmed);
      wakeQueue();
    });

    llmDone = true;
    wakeQueue();
    await playbackPump;

    const spokenText = collectedSegments.join(" ").replace(/\s+/g, " ").trim() || result.reply.trim();

    if (!collectedSegments.length && spokenText && !ctx.userBytesWhileSpeaking && !stopPlayback) {
      await speakSegment(spokenText);
    }

    const latencyMs =
      firstAudioAt && ctx.lastUserFinalAt && firstAudioAt > ctx.lastUserFinalAt
        ? firstAudioAt - ctx.lastUserFinalAt
        : undefined;
    if (latencyMs !== undefined) {
      log.info("turn.reaction_time", { callSid: ctx.callSid, ms: latencyMs });
    }

    log.info("turn.pipeline", {
      callSid: ctx.callSid,
      turnTotalMs: Date.now() - turnStartedAt,
      firstSentenceMs:
        firstSentenceQueuedAt && ctx.lastUserFinalAt
          ? firstSentenceQueuedAt - ctx.lastUserFinalAt
          : undefined,
      firstAudioMs: latencyMs,
      sentenceCount: queuedSentenceCount,
      bridgeInjected,
    });

    sendMark("gloria-end");

    if (totalAudioBytes > 0) {
      const totalPlayoutMs = Math.ceil(totalAudioBytes / 8) + 120;
      const elapsed = firstAudioAt ? Date.now() - firstAudioAt : 0;
      const remaining = Math.max(0, totalPlayoutMs - elapsed);
      if (remaining > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
    }

    ctx.speaking = false;
    currentTts = null;
    ctx.transcript.push({ role: "assistant", text: spokenText, at: Date.now(), latencyMs });
    ctx.flow = observeAssistantFlowState(ctx.flow, spokenText);

    if (!ctx.confirmedSlotPhrase) {
      const slot = extractConfirmedSlot(spokenText);
      if (slot) {
        ctx.confirmedSlotPhrase = slot;
        log.info("turn.slot_locked", { callSid: ctx.callSid, slot });
      }
    }

    const confirmedSlotThisTurn = !slotWasConfirmedBeforeTurn && Boolean(ctx.confirmedSlotPhrase);
    clearTimeout(audioSloTimer);
    return confirmedSlotThisTurn ? { ...result, hangup: false } : result;
  };

  const handleUserUtterance = async (userText: string) => {
    if (!ctx) return;
    clearSilenceOpenerTimer();

    const classification = classifyInboundSpeech(userText);

    if (classification === "voicemail") {
      ctx.detectedVoicemail = true;
      ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
      log.info("turn.voicemail_detected", { callSid: ctx.callSid, text: userText });
      try {
        ws.close(1000, "voicemail");
      } catch {
        /* ignore */
      }
      return;
    }

    if (classification === "queue") {
      ctx.waitingForDecisionMaker = true;
      ctx.queueDetected = true;
      ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
      log.info("turn.queue_detected", { callSid: ctx.callSid, text: userText });
      return;
    }

    if (ctx.waitingForDecisionMaker) {
      // In der Durchstellung/Warteschlange NICHT sprechen; erst reagieren,
      // wenn wieder eine normale menschliche Antwort erkennbar ist.
      if (classification !== "human") {
        ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
        log.info("turn.queue_wait", { callSid: ctx.callSid, text: userText });
        return;
      }
      ctx.waitingForDecisionMaker = false;
      log.info("turn.queue_handover_complete", { callSid: ctx.callSid });
    }

    if (pendingTurn) {
      // Nicht verlieren: Eine Unterbrechung wird direkt nach dem abgebrochenen
      // Gloria-Turn als neuer Turn verarbeitet. Zuvor wurde sie nur protokolliert
      // und blieb unbeantwortet.
      pendingUtterancesDuringTurn.push(userText);
      return;
    }
    pendingTurn = true;
    try {
      ctx.transcript.push({ role: "user", text: userText, at: Date.now() });
      updateConversationMemory(ctx, userText);
      ctx.flow = observeUserFlowState(ctx.flow, userText);
      ctx.lastUserFinalAt = Date.now();
      log.info("turn.user_said", { callSid: ctx.callSid, text: userText });

      // Vor der LLM-Antwort kurz auf das Playbook warten (max. 2 s),
      // damit Phase 3+ wirklich mit Playbook-Wissen gefahren wird. ABER:
      // beim allerersten Turn (Begrüßung + Aufzeichnungs-Frage) braucht
      // Gloria das Playbook noch nicht – wir warten dort nicht und sparen
      // dadurch eine spürbare Anfangs-Latenz nach dem "Hallo Müller".
      const isFirstTurn = ctx.transcript.length <= 1;
      if (!isFirstTurn && playbookReady && !ctx.playbookPrompt) {
        await Promise.race([
          playbookReady,
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }

      // FAST-PATH (Turn 1): Wenn der Anrufende sich mit dem erwarteten
      // Ansprechpartner-Namen gemeldet hat, generieren wir den Opener +
      // die Aufzeichnungs-Frage aus einem Template – ohne LLM. Das spart
      // ~2 s am Anfang (sonst muss gpt-4.1-mini ~280 Zeichen produzieren,
      // bevor TTS startet). Bei abweichendem Namen / Gatekeeper-Vermutung
      // fallen wir auf den LLM-Pfad zurück, damit Gatekeeper-Logik greift.
      if (isFirstTurn) {
        const templated = buildTurn1OpenerLine(ctx, userText);
        if (templated) {
          log.info("turn.fast_opener", { callSid: ctx.callSid });
          await speak(templated);
          return;
        }
      }

      const reply = await streamAndSpeak(userText);

      if (reply.transfer) {
        log.info("turn.transfer", { callSid: ctx.callSid });
        // Signal app backend to transfer the live call via Telnyx Call Control.
        const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
        const token = process.env.APP_INTERNAL_TOKEN || "";
        if (baseUrl && token) {
          try {
            await fetch(`${baseUrl}/api/telnyx/transfer`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ callControlId: ctx.callSid }),
            });
          } catch (err) {
            log.error("turn.transfer_notify_failed", { callSid: ctx.callSid, error: String(err) });
          }
        }
        try {
          ws.close(1000, "transfer");
        } catch {
          /* ignore */
        }
      } else if (reply.hangup) {
        log.info("turn.hangup", { callSid: ctx.callSid });
        try {
          ws.close(1000, "hangup");
        } catch {
          /* ignore */
        }
      }
    } finally {
      pendingTurn = false;
      const interruptedText = pendingUtterancesDuringTurn
        .splice(0)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (interruptedText && ws.readyState === ws.OPEN) {
        queueMicrotask(() => void handleUserUtterance(interruptedText));
      }
    }
  };

  ws.on("message", async (raw) => {
    let frame: TelnyxInbound;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : raw.toString()) as TelnyxInbound;
    } catch {
      return;
    }

    switch (frame.event) {
      case "connected": {
        log.info("ws.connected", { version: frame.version });
        break;
      }
      case "start": {
        const state = decodeClientState(frame.start.client_state);
        inboundEncoding = frame.start.media_format?.encoding || inboundEncoding;
        // Prefer the codec Telnyx actually reports for this stream leg.
        // This avoids hard mismatches (PCMA vs PCMU) that produce loud noise.
        const negotiatedCodec = detectTelephonyCodec(inboundEncoding);
        if (negotiatedCodec) {
          outboundEncoding = negotiatedCodec;
        }
        inboundSampleRate = frame.start.media_format?.sample_rate || inboundSampleRate;
        ctx = newContext({
          callSid: frame.start.call_control_id,
          streamSid: frame.stream_id,
          userId: state.userId,
          leadId: state.leadId,
          company: state.company,
          contactName: state.contactName,
          leadNote: state.leadNote,
          topic: state.topic,
          ownerRealName: state.ownerRealName,
          ownerCompanyName: state.ownerCompanyName,
          ownerGesellschaft: state.ownerGesellschaft,
          voiceId: state.voiceId,
          previousSummary: state.previousSummary,
          isCallback: state.isCallback === 1,
        });
        log.info("call.started", {
          callSid: ctx.callSid,
          streamSid: ctx.streamSid,
          company: ctx.company,
          topic: ctx.topic,
          inboundEncoding,
          outboundEncoding,
          inboundSampleRate,
        });

        // Pre-warm TLS/HTTP-Pools zu OpenAI + ElevenLabs SOFORT, damit die
        // allererste LLM-/TTS-Anfrage keine 300–600 ms Handshake-Latenz hat.
        // Der Anrufer braucht ~1–2 s, bis er sich meldet – diese Zeit nutzen wir.
        prewarmOpenAi();
        prewarmElevenLabs();

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
          const free = computeFreeSlots(slots, { daysAhead: 14, maxCount: 8, bufferMinutes: 90, minLeadDays: 7 });
          if (free.length) {
            ctx.freeSlotsPrompt = freeSlotsToPrompt(free);
          }
          log.info("busy.applied", { count: slots.length, free: free.length });
        });

        asr = openAsr({
          onPartial: (text) => {
            if (!ctx) return;
            if (text.trim().length > 0) {
              clearSilenceOpenerTimer();
            }
            // Echte Fortsetzungen schnell durchlassen. Kurze Füller und Echo
            // brechen Gloria nicht ab, aber sinnvolle Nachfragen oder Einwände
            // sollten eine Unterbrechung rechtfertigen.
            if (ctx.speaking && currentTts) {
              const trimmed = text.trim();
              if (shouldInterruptOnPartialSpeech(trimmed)) {
                log.info("turn.barge_in", { callSid: ctx.callSid, partial: trimmed });
                currentTts.abort();
                currentTts = null;
                clearOutboundAudio();
                ctx.speaking = false;
              }
            }
          },
          onFinal: (text) => {
            queueUserFinal(text);
          },
          onUtteranceEnd: () => {
            nudgeUserFinalFlush();
          },
          onError: (error) => {
            log.error("asr.session_error", { error: error.message });
          },
        });

        // Gloria wartet bewusst, bis der Angerufene sich gemeldet hat
        // ("Praxis Müller", "Hallo, Schmidt"). Erst danach reagiert das LLM
        // mit dem passenden Opener (Empfang vs. Entscheider).
        // Falls am anderen Ende niemand aktiv spricht, startet Gloria nach
        // kurzer Stille mit einem knappen, natürlichen Opener.
        const silenceMs = Math.max(
          1800,
          Number.parseInt(process.env.TELNYX_SILENCE_OPENER_MS || "4200", 10),
        );
        silenceOpenerTimer = setTimeout(() => {
          if (!ctx) return;
          if (pendingTurn || ctx.speaking) return;
          const heardUser = ctx.transcript.some((entry) => entry.role === "user" && entry.text.trim().length > 0);
          if (heardUser) return;
          const opener = buildSilenceOpenerLine(ctx);
          if (!opener) return;
          log.info("turn.silence_opener", { callSid: ctx.callSid, waitMs: silenceMs });
          void speak(opener);
        }, silenceMs);
        break;
      }
      case "media": {
        if (!ctx || !asr) return;
        const track = frame.media.track;
        if (track === "outbound" || track === "outbound_track") return;
        inboundFrameCount += 1;
        const buf = Buffer.from(frame.media.payload, "base64");
        const audio = normalizeInboundAudio(buf, inboundEncoding, inboundSampleRate);
        asr.send(audio);
        if (ctx.speaking) {
          ctx.userBytesWhileSpeaking += audio.length;
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
          flushUserFinals();
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
      case "error": {
        log.error("ws.stream_error", {
          callSid: ctx?.callSid,
          code: frame.payload?.code,
          title: frame.payload?.title,
          detail: frame.payload?.detail,
          streamSid: frame.stream_id,
        });
        break;
      }
    }
  });

  ws.on("close", async (code, reason) => {
    log.info("ws.closed", { code, reason: reason.toString(), callSid: ctx?.callSid });
    clearSilenceOpenerTimer();
    clearUserFinalCoalesceTimer();
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

function updateConversationMemory(ctx: CallContext, userText: string): void {
  const text = userText.trim();
  if (!text) return;
  const lower = text.toLowerCase();

  if (/keine\s+zeit|jetzt\s+schlecht|im\s+termin|unterwegs|sp[aä]ter|später/.test(lower)) {
    ctx.memory.tone = "rushed";
    pushUnique(ctx.memory.preferences, "zeitlich knapp, kurz und konkret antworten", 6);
  } else if (/kein\s+interesse|brauche\s+ich\s+nicht|lassen\s+sie\s+mich\s+in\s+ruhe|rufen\s+sie\s+nicht/.test(lower)) {
    ctx.memory.tone = "skeptical";
    pushUnique(ctx.memory.concerns, "grundsätzliche Ablehnung oder Abwehr", 8);
  } else if (/klingt\s+gut|passt|gerne|interessant|machen\s+wir/.test(lower)) {
    ctx.memory.tone = "open";
  }

  if (/beitrag|kosten|teuer|steiger|erh[öo]h/.test(lower)) {
    pushUnique(ctx.memory.concerns, "Sorge um steigende Beiträge/Kosten", 8);
  }
  if (/keine\s+glaskugel|unsicher|unklar|weiß\s+nicht|weiss\s+nicht/.test(lower)) {
    pushUnique(ctx.memory.concerns, "Unsicherheit über die zukünftige Entwicklung", 8);
  }
  if (/vormittag|nachmittag|fr[üu]h|sp[aä]t/.test(lower)) {
    pushUnique(ctx.memory.preferences, `Terminpräferenz erwähnt: ${text}`, 6);
  }
  if (/mail|e-?mail/.test(lower)) {
    pushUnique(ctx.memory.preferences, "möchte Infos per E-Mail bzw. fragt nach Mail-Bestätigung", 6);
  }

  if (text.length >= 16 && /(wir|ich|bei uns|unsere|mein|mich|mir)/i.test(text)) {
    pushUnique(ctx.memory.facts, text.replace(/\s+/g, " "), 10);
  }
}

function pushUnique(target: string[], value: string, max: number): void {
  if (!value) return;
  const key = normalize(value);
  const exists = target.some((item) => normalize(item) === key);
  if (!exists) target.push(value);
  if (target.length > max) target.splice(0, target.length - max);
}

function normalize(input: string): string {
  return input
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function buildSilenceOpenerLine(ctx: CallContext): string {
  const company = (ctx.ownerCompanyName || "").trim() || "unserer Agentur";
  const owner = (ctx.ownerRealName || "").trim() || "Herrn Duic";
  const contact = (ctx.contactName || "").trim();
  const note = (ctx.leadNote || "").trim();

  const noteLine = note
    ? `Zusatzkontext aus der Firmenliste: ${note}`
    : "";

  if (contact) {
    return [
      `Guten Tag, hier ist Gloria, die digitale Assistentin von ${company}.`,
      `Ich rufe im Auftrag von ${owner} an.`,
      noteLine,
      `Bin ich richtig bei Ihnen und darf ich kurz mit ${contact} sprechen?`,
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    `Guten Tag, hier ist Gloria, die digitale Assistentin von ${company}.`,
    `Ich rufe im Auftrag von ${owner} an.`,
    noteLine,
    "Bin ich richtig bei Ihnen und passt es kurz für eine Frage?",
  ]
    .filter(Boolean)
    .join(" ");
}

// buildOpener wurde entfernt: Gloria spricht erst, nachdem der
// Angerufene sich gemeldet hat (vgl. Telnyx media stream start event).

/**
 * FAST-PATH-Opener für Turn 1: erspart einen LLM-Roundtrip (~2 s) am
 * Gesprächsanfang. Der Opener ist deterministisch (Begrüßung + Vorstellung
 * + Aufzeichnungs-Frage), die einzige Variable ist der Nachname des
 * Ansprechpartners. Wir nutzen das Template NUR, wenn:
 *   1) Wir einen erwarteten Ansprechpartner-Namen aus den Custom-Params haben.
 *   2) Der Anrufende diesen Namen in seiner ersten Aussage genannt hat.
 *      ("Müller, hallo" / "Hier ist Neumann" / "Duic Musterbau, Neumann am Apparat")
 * Andernfalls geben wir null zurück und der LLM-Pfad übernimmt – damit die
 * Gatekeeper-Logik (Empfang/Vorzimmer) korrekt greift.
 */
function buildTurn1OpenerLine(ctx: CallContext, userText: string): string | null {
  const company = (ctx.ownerCompanyName || "").trim() || "unserer Agentur";
  const owner = (ctx.ownerRealName || "").trim() || "Herrn Duic";
  const expected = (ctx.contactName || "").trim();
  if (!expected) return null;

  // Nachname extrahieren: aus "Herr Neumann" / "Frau Dr. Müller-Schmidt" / "Neumann"
  const lastNameMatch = /([A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?)\s*$/.exec(expected);
  const expectedLast = lastNameMatch?.[1];
  if (!expectedLast || expectedLast.length < 3) return null;

  // Hat der Anrufer den Namen genannt? Word-boundary, case-insensitive.
  const escapedLast = expectedLast.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escapedLast}\\b`, "i");
  if (!re.test(userText)) return null;

  // Anrede konstruieren: bevorzugt mit Titel ("Herr Neumann" / "Frau Dr. Müller").
  const salutation = /^(Herr|Frau)\b/i.test(expected) ? expected : `Herr/Frau ${expectedLast}`;

  // Themen-Anker: kurze, vertriebsfreundliche Erklärung des Anlasses,
  // damit der Angerufene NICHT denken muss "warum sollte ich aufzeichnen
  // lassen, ich weiß ja gar nicht worum es geht". Wir mappen das
  // (lower-cased) Topic auf einen passenden Halbsatz; Default ist neutral.
  const topic = (ctx.topic || "").toLowerCase();
  let topicLine: string;
  if (/krank|pkv|gkv|beitr/i.test(topic)) {
    topicLine = `Kurzer Anlass: Es geht um eine kurze Einordnung zur privaten Krankenversicherung. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  } else if (/bav|altersvorsorge|rente|pension/i.test(topic)) {
    topicLine = `Kurzer Anlass: Es geht um Ihre betriebliche Altersvorsorge. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  } else if (/cyber|haftpflicht|gewerbe|inhalt/i.test(topic)) {
    topicLine = `Kurzer Anlass: Es geht um einen kurzen Abgleich Ihrer gewerblichen Absicherung. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  } else if (/strom|gas|energie/i.test(topic)) {
    topicLine = `Kurzer Anlass: Es geht um Ihre Energiekosten. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  } else if (ctx.topic && ctx.topic.trim().length > 0) {
    topicLine = `Kurzer Anlass: Es geht um ${ctx.topic.trim()}. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  } else {
    topicLine = `Kurzer Anlass: ${owner} hat eine kurze fachliche Einordnung für Sie. Darf ich Ihnen in 20 Sekunden sagen, worum es konkret geht?`;
  }

  // Kurze, natürliche Begrüßung mit offener Abschlussfrage.
  // Aufzeichnungsfrage bewusst NICHT im Fast-Path: LLM formuliert sie
  // im nächsten Turn frei, ohne "bitte antworten Sie mit JA oder NEIN".
  return [
    `Guten Tag ${salutation}, hier ist Gloria, die digitale Vertriebsassistentin von ${company}.`,
    `Ich rufe im Auftrag von ${owner} an.`,
    topicLine,
  ].join(" ");
}

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
export function extractConfirmedSlot(text: string): string | null {
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
    /\bnotiere\s+ich\b/.test(lower) ||
    /\bich\s+(?:merke|merk)\s+(?:mir|ich\s+mir)\b/.test(lower) ||
    /\b(?:merke|merk)\s+ich\s+mir\b/.test(lower) ||
    /\bich\s+trage\s+(?:(?:sie|dich|ihn)\s+f[üu]r\s+|(?:ihn|den\s+termin)\s*)?(?:.*?\s+)?(?:ein|gleich\s+ein)\b/.test(lower) ||
    /\bich\s+buche\b/.test(lower) ||
    /\bsteht\s+(?:ihr|der)?\s*termin\b/.test(lower) ||
    /\bdann\s+steht\b[^.?!]*\btermin\b/.test(lower) ||
    /\bperfekt\b[^.?!]*\btermin\b/.test(lower) ||
    /\bich\s+habe\b[^.?!]*\bf[üu]r\s+sie\s+reserviert\b/.test(lower) ||
    /\bich\s+reserviere\b/.test(lower) ||
    /\breserviere\s+ich\b/.test(lower) ||
    /\b(?:ist|wird)\b[^.?!]*\bf[üu]r\s+sie\s+reserviert\b/.test(lower) ||
    /\b(?:ist|wird)\b[^.?!]*\bf[üu]r\s+sie\s+(?:fest\s+)?eingetragen\b/.test(lower);
  if (!isConfirmation) return null;

  // Uhrzeiten kommen als Wörter ODER als Ziffern ("10:30 Uhr" / "zehn Uhr dreißig").
  // Trailing-Wort nach "Uhr" nur wenn es eine Minutenangabe ist ("dreißig", "fünfzehn" etc.) —
  // NICHT "für", "das", "mit" o.ä.
  const reWeekday = /\b(?:am\s+)?((?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag)[^.?!]*?\bum\s+(?:[a-zäöüß]+|\d{1,2}(?::\d{2})?)\s+Uhr(?:\s+(?:fünf|zehn|fünfzehn|zwanzig|fünfundzwanzig|dreißig|fünfunddreißig|vierzig|fünfundvierzig|fünfzig))?)/i;
  const weekdayMatch = reWeekday.exec(text);
  if (weekdayMatch) {
    return weekdayMatch[1].trim().replace(/\s+/g, " ");
  }

  // Fallback für Formulierungen ohne Wochentag, z. B.
  // "... den 20. August um 17:30 Uhr ..."
  const reDateOnly = /\b(((?:(?:Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag|Sonntag),?\s+)?)?(?:den\s+)?\d{1,2}\.\s*[A-Za-zÄÖÜäöüß]+[^.?!]*?\bum\s+(?:[a-zäöüß]+|\d{1,2}(?::\d{2})?)\s+Uhr(?:\s+(?:fünf|zehn|fünfzehn|zwanzig|fünfundzwanzig|dreißig|fünfunddreißig|vierzig|fünfundvierzig|fünfzig))?)/i;
  const dateOnlyMatch = reDateOnly.exec(text);
  if (!dateOnlyMatch) return null;
  return dateOnlyMatch[1].trim().replace(/\s+/g, " ");
}

