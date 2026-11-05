import { globalJobQueue } from "./job-queue";
import { findUserById } from "./report-db";
import type { CallReport } from "./types";

export const APPOINTMENT_EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z0-9][a-z0-9-]*[a-z0-9](?![a-z0-9-])/i;

export async function appointmentConfirmationDelivery(userId?: string): Promise<"automatic" | "manual"> {
  if (!userId?.trim()) {
    throw new Error("Für die Terminbestätigung fehlt der zugehörige Benutzer.");
  }
  const owner = await findUserById(userId);
  if (!owner) {
    throw new Error("Der Benutzer für die Terminbestätigung wurde nicht gefunden.");
  }
  return owner.role === "master" ? "automatic" : "manual";
}

export async function enqueueAppointmentConfirmation(
  report: CallReport,
  attendeeEmail?: string,
  missingBasisQuestions: string[] = [],
): Promise<{ delivered: false; reason: string }> {
  const delivery = await appointmentConfirmationDelivery(report.userId);
  if (delivery === "manual") {
    return { delivered: false, reason: "Die Terminbestätigung wird vom Benutzer manuell versendet." };
  }

  const jobId = await globalJobQueue.enqueue("send_invite", report.callSid || "unknown", {
    reportId: report.id,
    report,
    leadId: report.leadId,
    userId: report.userId,
    attendeeEmail,
    missingBasisQuestions,
  });
  return { delivered: false, reason: `Appointment invite queued for delivery (jobId: ${jobId})` };
}
