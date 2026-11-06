// Only causes where the callee never picked up; answered calls are classified by the worker.
const UNANSWERED_HANGUP_RESULTS: Record<string, string> = {
  user_busy: "Besetzt",
  no_answer: "Unbeantwortet",
  timeout: "Unbeantwortet",
  no_user_response: "Unbeantwortet",
  call_rejected: "Abgewiesen",
  unallocated_number: "Ungültig",
  invalid_number_format: "Ungültig",
  number_changed: "Ungültig",
  subscriber_absent: "Unerreichbar",
  destination_out_of_order: "Unerreichbar",
  network_out_of_order: "Netzfehler",
  normal_temporary_failure: "Netzfehler",
  recovery_on_timer_expire: "Netzfehler",
};

export function resultDetailForUnansweredHangup(hangupCause?: unknown): string | undefined {
  if (typeof hangupCause !== "string") return undefined;
  const cause = hangupCause.trim().toLowerCase();
  return cause ? UNANSWERED_HANGUP_RESULTS[cause] : undefined;
}
