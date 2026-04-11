interface ElevenLabsResult {
  provider: "elevenlabs" | "browser";
  audioBase64?: string;
  audioMimeType?: string;
  error?: string;
}

export function isElevenLabsConfigured() {
  return Boolean(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID);
}

export async function generateElevenLabsPreview(text: string): Promise<ElevenLabsResult> {
  if (!isElevenLabsConfigured()) {
    return {
      provider: "browser",
      error: "ElevenLabs ist noch nicht konfiguriert.",
    };
  }

  const speechText = text
    .replaceAll("im Auftrag von Herrn Matthias Duic", "im Auftrag von Matthias Duic")
    .replaceAll("von Herrn Matthias Duic", "im Auftrag von Matthias Duic")
    .replaceAll(
      "die betriebliche Krankenversicherung aktuell nutzen",
      "die betriebliche Krankenversicherung inzwischen gezielt nutzen",
    )
    .replaceAll(" – ", ", ")
    .replaceAll(": ", ", ")
    .replaceAll(". Ich ", ", ich ")
    .replaceAll(". Viele ", ", viele ")
    .replace(/\s+/g, " ")
    .trim();

  try {
    const elevenLabsUrl = new URL(
      `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`,
    );
    elevenLabsUrl.searchParams.set(
      "optimize_streaming_latency",
      process.env.ELEVENLABS_LATENCY_MODE || "3",
    );

    const response = await fetch(elevenLabsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
        "xi-api-key": process.env.ELEVENLABS_API_KEY as string,
      },
      body: JSON.stringify({
        text: speechText,
        model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
        voice_settings: {
          stability: Number(process.env.ELEVENLABS_STABILITY || 0.38),
          similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY_BOOST || 0.88),
          style: Number(process.env.ELEVENLABS_STYLE || 0.3),
          speed: Number(process.env.ELEVENLABS_SPEED || 0.97),
          use_speaker_boost:
            (process.env.ELEVENLABS_USE_SPEAKER_BOOST || "true") === "true",
        },
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const details = await response.text();

      return {
        provider: "browser",
        error: `ElevenLabs Fehler: ${response.status} ${details}`,
      };
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());

    return {
      provider: "elevenlabs",
      audioBase64: audioBuffer.toString("base64"),
      audioMimeType: "audio/mpeg",
    };
  } catch (error) {
    return {
      provider: "browser",
      error:
        error instanceof Error
          ? `ElevenLabs ist momentan nicht erreichbar: ${error.message}`
          : "ElevenLabs ist momentan nicht erreichbar.",
    };
  }
}
