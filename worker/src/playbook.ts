import { fetch } from "undici";
import { log } from "./log.js";

export type PlaybookFields = {
  topic?: string;
  // Vereinfachtes 3-Felder-Modell
  behavior?: string;
  requiredData?: string;
  knowledge?: string;
  // Eigenständige Sales-Felder
  objectionResponses?: string;
  proofPoints?: string;
  // Legacy-Felder bleiben optional vorhanden, werden aber nicht mehr in den Prompt gerendert.
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

/** Rendert das vereinfachte 3-Felder-Playbook in einen Systemprompt-Block. */
export function playbookToSystemPrompt(pb: PlaybookFields): string {
  const topic = (pb.topic || "").trim();
  const behavior = (pb.behavior || "").trim();
  const requiredData = (pb.requiredData || "").trim();
  const knowledge = (pb.knowledge || "").trim();
  const objectionResponses = (pb.objectionResponses || "").trim();
  const proofPoints = (pb.proofPoints || "").trim();

  // Wenn keines der relevanten Felder gefüllt ist, geben wir einen leeren
  // Block zurück. Legacy-Felder werden bewusst NICHT mehr verwendet, damit
  // die Anti-Floskel-Strategie greift und Gloria sich nur auf die kuratierten
  // Blöcke stützt.
  if (!behavior && !requiredData && !knowledge && !objectionResponses && !proofPoints) {
    return topic ? `THEMA DIESES CALLS: ${topic}` : "";
  }

  const parts: string[] = [];
  parts.push("PLAYBOOK – verbindlicher Leitfaden für dieses Gespräch:");
  if (topic) parts.push(`THEMA: ${topic}`);

  if (behavior) {
    parts.push("");
    parts.push("VERHALTEN & TONALITÄT (themenspezifisch):");
    parts.push(behavior);
  }

  if (requiredData) {
    parts.push("");
    parts.push("BASISDATEN / PFLICHTFRAGEN (in der Basisdaten-Phase einzeln abfragen):");
    parts.push(requiredData);
  }

  if (proofPoints) {
    parts.push("");
    parts.push(
      "ZAHLEN & FAKTEN (HARTE PFLICHT — in Phase 5 mind. eine dieser Zahlen aktiv nennen, bevor zu Phase 6 übergeleitet wird):",
    );
    parts.push(proofPoints);
  }

  if (objectionResponses) {
    parts.push("");
    parts.push(
      "EINWAND-BIBLIOTHEK (verbindliche Konter-Linien — Format pro Zeile: \"Einwand: Konter\". Nutze die Konter-Logik in eigenen Worten, max. 1–2 Sätze, OHNE \"Ich verstehe\"/\"Absolut\"-Vorlauf):",
    );
    parts.push(objectionResponses);
  }

  if (knowledge) {
    parts.push("");
    parts.push(
      "FACHWISSEN (nutze diese konkreten Fakten, BEVOR du auf Bilder/Metaphern ausweichst):",
    );
    parts.push(knowledge);
  }

  return parts.join("\n");
}
