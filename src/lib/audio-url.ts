import { signAudioText } from "@/lib/audio-signature";

/**
 * Baut die signierte URL zum ElevenLabs-TTS-Endpoint.
 * Hängt `exp` (Unix-Sekunden) und `sig` (HMAC-SHA256 base64url) an, damit
 * /api/twilio/audio beliebigen Fremdtext ablehnen kann.
 */
export async function buildSignedAudioUrl(baseUrl: string, text: string): Promise<string> {
  const url = new URL(`${baseUrl}/api/twilio/audio`);
  url.searchParams.set("text", text);

  const { exp, sig } = await signAudioText(text);
  url.searchParams.set("exp", String(exp));
  url.searchParams.set("sig", sig);

  return url.toString();
}
