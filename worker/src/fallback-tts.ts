import { fetch } from "undici";

export type TelephonyAudioFormat = "alaw_8000" | "ulaw_8000";

const SEG_A_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];
const SEG_U_END = [0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff];

function segment(value: number, table: number[]): number {
  for (let index = 0; index < table.length; index += 1) {
    if (value <= table[index]) return index;
  }
  return table.length;
}

/** ITU-T G.711 A-law encoding of one signed 16-bit sample. */
export function linearToAlaw(sample: number): number {
  let value = sample >> 3;
  let mask: number;
  if (value >= 0) {
    mask = 0xd5;
  } else {
    mask = 0x55;
    value = -value - 1;
  }
  const seg = segment(value, SEG_A_END);
  if (seg >= 8) return 0x7f ^ mask;
  const aval = (seg << 4) | ((seg < 2 ? value >> 1 : value >> seg) & 0x0f);
  return aval ^ mask;
}

/** ITU-T G.711 mu-law encoding of one signed 16-bit sample. */
export function linearToUlaw(sample: number): number {
  let value = sample >> 2;
  let mask: number;
  if (value < 0) {
    value = -value;
    mask = 0x7f;
  } else {
    mask = 0xff;
  }
  if (value > 8159) value = 8159;
  value += 0x84 >> 2;
  const seg = segment(value, SEG_U_END);
  if (seg >= 8) return 0x7f ^ mask;
  return ((seg << 4) | ((value >> (seg + 1)) & 0x0f)) ^ mask;
}

/**
 * Converts streamed 24 kHz 16-bit mono PCM into 8 kHz G.711. Averaging three input samples per output
 * sample acts as a simple low-pass filter, which is sufficient for narrow-band telephony.
 */
export class Pcm24kToG711Encoder {
  private remainder = Buffer.alloc(0);

  constructor(private readonly format: TelephonyAudioFormat) {}

  push(chunk: Buffer): Buffer {
    const data = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const frameBytes = 6;
    const frames = Math.floor(data.length / frameBytes);
    const output = Buffer.alloc(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * frameBytes;
      const average = Math.round((data.readInt16LE(offset) + data.readInt16LE(offset + 2) + data.readInt16LE(offset + 4)) / 3);
      output[frame] = this.format === "alaw_8000" ? linearToAlaw(average) : linearToUlaw(average);
    }
    this.remainder = Buffer.from(data.subarray(frames * frameBytes));
    return output;
  }
}

export function isFallbackTtsEnabled(): boolean {
  return process.env.FALLBACK_TTS_ENABLED?.trim() !== "false" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

/** Second voice provider used only when ElevenLabs produced no audio, so the caller never hears silence. */
export async function streamFallbackSpeech(
  text: string,
  format: TelephonyAudioFormat,
  signal: AbortSignal,
  onChunk: (chunk: Buffer) => void,
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY fehlt für die Ersatzstimme");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.FALLBACK_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
      voice: process.env.FALLBACK_TTS_VOICE?.trim() || "coral",
      input: text,
      response_format: "pcm",
      instructions: "Sprich natürliches, freundliches Hochdeutsch in ruhigem, professionellem Tempo wie eine Assistentin am Telefon.",
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Ersatzstimme antwortete ${response.status}${details ? `: ${details.slice(0, 160)}` : ""}`);
  }
  if (!response.body) throw new Error("Ersatzstimme lieferte keinen Audiostream");
  const encoder = new Pcm24kToG711Encoder(format);
  for await (const chunk of response.body) {
    const encoded = encoder.push(Buffer.from(chunk as Uint8Array));
    if (encoded.length) onChunk(encoded);
  }
}
