import { getUserCrmConnection } from "@/lib/report-db";

export interface CrmCompanySyncEvent {
  eventId: string;
  companyId: number;
  companyUpdates?: Record<string, string | number | null>;
  note?: { text: string };
  appointment?: {
    scheduledAt: string;
    title?: string;
    description?: string;
    contactPerson?: string;
  };
}

export async function syncCrmCompanyEvent(userId: string, event: CrmCompanySyncEvent): Promise<void> {
  const connection = await getUserCrmConnection(userId);
  if (!connection?.apiUrl || !connection.crmUserId) {
    throw new Error("Für dieses Gloria-Konto ist kein CRM-Benutzerkonto gekoppelt.");
  }
  const token = process.env.GLORIA_CRM_INTEGRATION_TOKEN?.trim();
  if (!token) {
    throw new Error("Der sichere CRM-Synchronisierungsschlüssel ist in Gloria nicht konfiguriert.");
  }

  let response: Response;
  try {
    response = await fetch(`${connection.apiUrl}/integrations/gloria/sync-company`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gloria-integration-token": token,
      },
      body: JSON.stringify({
        event_id: event.eventId,
        crm_user_id: connection.crmUserId,
        gloria_user_id: userId,
        company_id: event.companyId,
        company_updates: event.companyUpdates,
        note: event.note,
        appointment: event.appointment && {
          scheduled_at: event.appointment.scheduledAt,
          title: event.appointment.title,
          description: event.appointment.description,
          contact_person: event.appointment.contactPerson,
        },
      }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.error("Gloria-to-CRM synchronization request failed:", error);
    throw new Error("CRM-Server nicht erreichbar. Die Daten konnten nicht abgeglichen werden.");
  }

  const payload = await response.json().catch(() => ({})) as { detail?: string; error?: string };
  if (!response.ok) {
    throw new Error(payload.detail || payload.error || `CRM-Abgleich fehlgeschlagen (HTTP ${response.status}).`);
  }
}
