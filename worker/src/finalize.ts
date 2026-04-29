import { fetch } from "undici";
import type { CallContext } from "./state.js";
import { log } from "./log.js";

type Outcome = "Termin" | "Absage" | "Wiedervorlage" | "Kein Kontakt";

type ExtractedReport = {
  outcome: Outcome;
  appointmentAt?: string;
  contactEmail?: string;
  summary: string;
  nextCallAt?: string;
  directDial?: string;
};

const EXTRACT_PROMPT = `Du bist ein Auswerter für Akquise-Telefonate. Lies das Transkript unten und gib AUSSCHLIESSLICH ein JSON-Objekt zurück mit folgenden Feldern:
{
  "outcome": "Termin" | "Absage" | "Wiedervorlage" | "Kein Kontakt",
  "appointmentAt": "ISO-8601 mit Zeitzone (z. B. 2026-04-30T15:00:00+02:00) oder null",
  "contactEmail": "vom Kunden bestätigte Mailadresse oder null",
  "nextCallAt": "ISO-8601 mit Zeitzone für den vereinbarten Rückruf-Zeitpunkt (NUR bei Wiedervorlage), sonst null",
  "directDial": "vom Anrufenden für den Rückruf genannte Direkt-Durchwahl/Mobilnummer als reine E.164- oder Klar-Ziffern-Zeichenkette (NUR bei Wiedervorlage), sonst null",
  "summary": "5–10 Sätze Deutsch, fasse Verlauf, Bedarf, vereinbarten Termin und ggf. erfasste Basisdaten zusammen"
}
Regeln:
- "Termin" nur, wenn ein konkreter Termin (Datum + Uhrzeit) bestätigt wurde.
- "Absage" wenn der Anrufende ablehnt.
- "Wiedervorlage" wenn auf später verschoben wurde, ohne festen Termin – insbesondere wenn der Anrufende keinen Kalender-Zugriff hatte und einen Rückruf-Zeitpunkt + (idealerweise) Direktdurchwahl genannt hat.
- "Kein Kontakt" sonst (kein Entscheider erreicht, abgebrochen).
- appointmentAt: nutze die LETZTE im Transkript bestätigte Termin-Aussage. Wenn der Anrufende "Donnerstag, 30. April, 15 Uhr" sagt, nimm das Datum exakt so.
- nextCallAt + directDial: NUR füllen, wenn outcome="Wiedervorlage" UND der Anrufende explizit Tag/Uhrzeit für den Rückruf bzw. eine Durchwahl/Nummer genannt UND bestätigt hat.
- contactEmail nur, wenn explizit vom Anrufenden buchstabiert/genannt UND bestätigt.`;

export async function extractReport(ctx: CallContext): Promise<ExtractedReport | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    log.error("finalize.no_openai_key");
    return null;
  }
  if (ctx.transcript.length < 2) {
    return null;
  }

  const transcriptText = ctx.transcript
    .map((t) => `${t.role === "user" ? "Kunde" : "Gloria"}: ${t.text}`)
    .join("\n");

  const today = new Date();
  const todayStr = today.toLocaleDateString("de-DE", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Europe/Berlin",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: `${EXTRACT_PROMPT}\n\nHeute ist ${todayStr}.` },
          { role: "user", content: `Firma: ${ctx.company || "?"}\nThema: ${ctx.topic || "?"}\n\nTranskript:\n${transcriptText}` },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      log.error("finalize.openai_error", { status: res.status, body: body.slice(0, 200) });
      return null;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Partial<ExtractedReport> & {
      appointmentAt?: string | null;
      contactEmail?: string | null;
      nextCallAt?: string | null;
      directDial?: string | null;
    };

    const outcome: Outcome =
      parsed.outcome === "Termin" || parsed.outcome === "Absage" || parsed.outcome === "Wiedervorlage"
        ? parsed.outcome
        : "Kein Kontakt";

    const appointmentAt =
      typeof parsed.appointmentAt === "string" && !Number.isNaN(Date.parse(parsed.appointmentAt))
        ? new Date(parsed.appointmentAt).toISOString()
        : undefined;

    const contactEmail =
      typeof parsed.contactEmail === "string" && /.+@.+\..+/.test(parsed.contactEmail)
        ? parsed.contactEmail.trim()
        : undefined;

    const nextCallAt =
      outcome === "Wiedervorlage" &&
      typeof parsed.nextCallAt === "string" &&
      !Number.isNaN(Date.parse(parsed.nextCallAt))
        ? new Date(parsed.nextCallAt).toISOString()
        : undefined;

    const directDial =
      outcome === "Wiedervorlage" && typeof parsed.directDial === "string"
        ? parsed.directDial.replace(/[^\d+]/g, "").trim() || undefined
        : undefined;

    const summary = (parsed.summary || "").trim() || "Kein Gesprächsinhalt erfasst.";

    return { outcome, appointmentAt, contactEmail, summary, nextCallAt, directDial };
  } catch (error) {
    log.error("finalize.extract_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function postReport(ctx: CallContext): Promise<void> {
  if (!ctx.company || !ctx.topic) {
    log.info("finalize.skip_no_company_or_topic", { callSid: ctx.callSid });
    return;
  }

  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    log.error("finalize.no_base_url");
    return;
  }

  const extracted = await extractReport(ctx);

  // Deterministischer Override: Wenn der Worker bereits eine bestätigte
  // Slot-Phrase erkannt hat (Phase-7-Termin-Bestätigung), ist outcome=Termin
  // und das Datum lässt sich aus der Phrase ableiten – unabhängig vom LLM.
  let outcome: "Termin" | "Absage" | "Wiedervorlage" | "Kein Kontakt" =
    extracted?.outcome || "Kein Kontakt";
  let appointmentAt: string | undefined = extracted?.appointmentAt;
  let summary: string =
    extracted?.summary ||
    `Anruf bei ${ctx.company} zum Thema ${ctx.topic}. Keine Auswertung verfügbar.`;
  const contactEmail: string | undefined = extracted?.contactEmail;

  if (ctx.confirmedSlotPhrase) {
    outcome = "Termin";
    // Bevorzuge die gelockte Slot-Phrase – das LLM kann in der Schluss-
    // Zusammenfassung halluzinieren (anderer Tag/Uhrzeit). Die ge-lockte
    // Phrase stammt aus Glorias eigener Bestätigung in Phase 7 und ist
    // damit die zuverlaessigere Quelle.
    const parsed = parseSlotPhraseToIso(ctx.confirmedSlotPhrase);
    if (parsed) {
      appointmentAt = parsed;
    } else if (!appointmentAt) {
      // kein Parse-Ergebnis und LLM hat auch nichts geliefert -> nichts setzen
    }
    if (!extracted) {
      summary = `Termin vereinbart: ${ctx.confirmedSlotPhrase}.`;
    }
  }

  const token = process.env.APP_INTERNAL_TOKEN || "";
  const url = `${baseUrl}/api/calls/webhook`;

  const body = {
    userId: ctx.userId,
    leadId: ctx.leadId,
    callSid: ctx.callSid,
    company: ctx.company,
    contactName: ctx.contactName,
    topic: ctx.topic,
    summary,
    outcome,
    appointmentAt,
    nextCallAt: extracted?.nextCallAt,
    directDial: extracted?.directDial,
    recordingConsent: true,
  };

  log.info("finalize.posting", {
    callSid: ctx.callSid,
    url,
    outcome,
    appointmentAt,
    hasSlot: Boolean(ctx.confirmedSlotPhrase),
    hasUserId: Boolean(ctx.userId),
    hasLeadId: Boolean(ctx.leadId),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-gloria-internal-token": token } : {}),
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      log.error("finalize.post_failed", { status: res.status, body: text.slice(0, 400) });
      return;
    }
    log.info("finalize.posted", {
      callSid: ctx.callSid,
      outcome,
      appointmentAt,
      email: contactEmail,
      response: text.slice(0, 200),
    });
  } catch (error) {
    log.error("finalize.post_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const ORDINAL_DAY: Record<string, number> = {
  "ersten": 1, "zweiten": 2, "dritten": 3, "vierten": 4, "fünften": 5,
  "sechsten": 6, "siebten": 7, "achten": 8, "neunten": 9, "zehnten": 10,
  "elften": 11, "zwölften": 12, "dreizehnten": 13, "vierzehnten": 14,
  "fünfzehnten": 15, "sechzehnten": 16, "siebzehnten": 17, "achtzehnten": 18,
  "neunzehnten": 19, "zwanzigsten": 20, "einundzwanzigsten": 21,
  "zweiundzwanzigsten": 22, "dreiundzwanzigsten": 23, "vierundzwanzigsten": 24,
  "fünfundzwanzigsten": 25, "sechsundzwanzigsten": 26, "siebenundzwanzigsten": 27,
  "achtundzwanzigsten": 28, "neunundzwanzigsten": 29, "dreißigsten": 30,
  "einunddreißigsten": 31,
};

const MONTHS: Record<string, number> = {
  januar: 1, februar: 2, märz: 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7,
  august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

const NUMBER_WORD: Record<string, number> = {
  "null": 0, "eins": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "sechs": 6,
  "sieben": 7, "acht": 8, "neun": 9, "zehn": 10, "elf": 11, "zwölf": 12,
  "dreizehn": 13, "vierzehn": 14, "fünfzehn": 15, "sechzehn": 16, "siebzehn": 17,
  "achtzehn": 18, "neunzehn": 19, "zwanzig": 20, "einundzwanzig": 21,
  "zweiundzwanzig": 22, "dreiundzwanzig": 23, "dreißig": 30, "fünfundvierzig": 45,
};

/**
 * Parsed eine Slot-Phrase wie "Donnerstag, den siebten Mai um vierzehn Uhr dreißig"
 * in ein ISO-Datum (Berlin-TZ). Best effort – gibt undefined zurück, wenn unklar.
 */
function parseSlotPhraseToIso(phrase: string): string | undefined {
  const lower = phrase.toLowerCase();
  let day: number | undefined;
  for (const [word, value] of Object.entries(ORDINAL_DAY)) {
    if (lower.includes(word)) {
      day = value;
      break;
    }
  }
  let month: number | undefined;
  for (const [word, value] of Object.entries(MONTHS)) {
    if (lower.includes(word)) {
      month = value;
      break;
    }
  }
  // Uhrzeit: "um <hour> Uhr [<minute>]"
  const hourMatch = /\bum\s+([a-zäöüß]+)\s+uhr(?:\s+([a-zäöüß]+))?/.exec(lower);
  let hour = 0;
  let minute = 0;
  if (hourMatch) {
    hour = NUMBER_WORD[hourMatch[1]] ?? 0;
    if (hourMatch[2]) minute = NUMBER_WORD[hourMatch[2]] ?? 0;
  }
  if (!day || !month) return undefined;

  const now = new Date();
  let year = now.getFullYear();
  // Wenn das Datum in der Vergangenheit läge, nimm nächstes Jahr.
  const candidate = new Date(Date.UTC(year, month - 1, day, hour - 2, minute));
  if (candidate.getTime() < now.getTime() - 86400000) {
    year += 1;
  }
  // Berlin-TZ: Sommerzeit MESZ = UTC+2 (April–Oktober). Vereinfacht: subtrahiere 2h.
  const iso = new Date(Date.UTC(year, month - 1, day, hour - 2, minute)).toISOString();
  return iso;
}
