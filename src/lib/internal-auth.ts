// Gemeinsame Header für interne Server-zu-Server-Aufrufe (z. B. zwischen
// /api/twilio/voice → /api/twilio/inbound/lookup). Nutzt entweder Basic Auth
// oder einen gemeinsamen Token. Wird in Edge- und Node-Runtime eingesetzt.

export function buildInternalHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD?.trim();
  const token = process.env.CALL_STATE_SECRET?.trim() || process.env.CRON_SECRET?.trim();

  if (username && password) {
    headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;
  }

  if (token) {
    headers["x-gloria-internal-token"] = token;
  }

  return headers;
}
