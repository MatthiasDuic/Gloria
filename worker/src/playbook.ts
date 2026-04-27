import { fetch } from "undici";
import { log } from "./log.js";

export type PlaybookFields = {
  topic?: string;
  opener?: string;
  discovery?: string;
  objectionHandling?: string;
  close?: string;
  aiKeyInfo?: string;
  consentPrompt?: string;
  pkvHealthIntro?: string;
  pkvHealthQuestions?: string;
  gatekeeperTask?: string;
  gatekeeperBehavior?: string;
  decisionMakerTask?: string;
  decisionMakerBehavior?: string;
  decisionMakerContext?: string;
  appointmentGoal?: string;
  receptionTopicReason?: string;
  problemBuildup?: string;
  conceptTransition?: string;
  appointmentConfirmation?: string;
  availableAppointmentSlots?: string;
};

/**
 * Lädt das Playbook für (userId, topic) vom Vercel-Backend über den
 * internen Token-Endpoint /api/twilio/playbooks.
 */
export async function loadPlaybook(opts: {
  userId?: string;
  topic?: string;
}): Promise<PlaybookFields | null> {
  const baseUrl = (process.env.APP_BASE_URL || "").replace(/\/$/, "");
  const token = process.env.APP_INTERNAL_TOKEN?.trim();
  if (!baseUrl || !token) {
    log.warn("playbook.skipped_no_config");
    return null;
  }
  if (!opts.topic) {
    log.warn("playbook.skipped_no_topic");
    return null;
  }

  const params = new URLSearchParams();
  if (opts.userId) params.set("userId", opts.userId);

  const url = `${baseUrl}/api/twilio/playbooks${params.toString() ? `?${params.toString()}` : ""}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { "x-gloria-internal-token": token },
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn("playbook.http_error", { status: res.status });
      return null;
    }
    const json = (await res.json()) as { playbooks?: PlaybookFields[] };
    const list = Array.isArray(json.playbooks) ? json.playbooks : [];
    const match =
      list.find((p) => (p.topic || "").toLowerCase() === opts.topic!.toLowerCase()) ||
      list[0] ||
      null;
    if (!match) {
      log.warn("playbook.no_match", { topic: opts.topic });
      return null;
    }
    log.info("playbook.loaded", { topic: match.topic, fields: Object.keys(match).length });
    return match;
  } catch (error) {
    log.warn("playbook.fetch_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Verdichtet die wichtigsten Playbook-Felder zu einem zusätzlichen Systemprompt-Abschnitt. */
export function playbookToSystemPrompt(pb: PlaybookFields): string {
  const lines: string[] = [];
  const push = (label: string, value: string | undefined) => {
    const v = (value || "").trim();
    if (v) lines.push(`- ${label}: ${v}`);
  };

  push("Thema", pb.topic);
  push("Eröffnung (Empfang)", pb.opener);
  push("Grund für Ansprache am Empfang", pb.receptionTopicReason);
  push("Aufgabe Gatekeeper", pb.gatekeeperTask);
  push("Verhalten Gatekeeper", pb.gatekeeperBehavior);
  push("Aufgabe Entscheider:in", pb.decisionMakerTask);
  push("Verhalten Entscheider:in", pb.decisionMakerBehavior);
  push("Kontext Entscheider:in", pb.decisionMakerContext);
  push("Bedarfsanalyse", pb.discovery);
  push("Problem-Aufbau", pb.problemBuildup);
  push("Übergang zum Konzept", pb.conceptTransition);
  push("Einwandbehandlung", pb.objectionHandling);
  push("Abschluss / Termin", pb.close);
  push("Terminziel", pb.appointmentGoal);
  push("Bestätigung Termin", pb.appointmentConfirmation);
  push("Mögliche Terminfenster", pb.availableAppointmentSlots);
  push("Einwilligungs-Hinweis", pb.consentPrompt);
  push("PKV-Gesundheitseinleitung", pb.pkvHealthIntro);
  push("PKV-Gesundheitsfragen", pb.pkvHealthQuestions);
  push("Fachliche Eckpunkte (Wissen)", pb.aiKeyInfo);

  if (lines.length === 0) return "";
  return [
    "PLAYBOOK – verbindlicher Leitfaden für dieses Gespräch:",
    "Halte dich strikt an die Reihenfolge der Phasen aus dem Systemprompt (Begrüßung → Konsens → Discovery → Problem-Aufbau → Konzept → Termin).",
    "Nutze die folgenden Inhalte fachlich und sprachlich. Erfinde nichts darüber hinaus:",
    ...lines,
    "",
    "Wichtig: Wenn das Gegenüber 'worum geht es?' fragt, gib in 1–2 Sätzen die fachlichen Eckpunkte aus 'Fachliche Eckpunkte (Wissen)' bzw. 'Problem-Aufbau' wieder – KEINE Termin-Frage in diesem Moment.",
  ].join("\n");
}
