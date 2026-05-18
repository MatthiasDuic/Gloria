import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { ensureMasterAdmin } from "@/lib/report-db";
import { getTelnyxApiBaseUrl } from "@/lib/telnyx";

export const runtime = "nodejs";

type TelnyxCallControlApplication = {
  id?: string;
  application_name?: string;
  outbound?: {
    channel_limit?: number;
    outbound_voice_profile_id?: string;
  };
};

type TelnyxOutboundVoiceProfile = {
  id?: string;
  name?: string;
  enabled?: boolean;
  service_plan?: string;
  traffic_type?: string;
  usage_payment_method?: string;
};

function requireMaster(request: Request) {
  const user = getSessionUserFromRequest(request);

  if (!user) {
    throw new Error("UNAUTHORIZED");
  }

  if (user.role !== "master") {
    throw new Error("FORBIDDEN");
  }

  return user;
}

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  }
  return value;
}

async function telnyxRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const apiKey = readEnv("TELNYX_API_KEY");
  const response = await fetch(`${getTelnyxApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);

  if (!response.ok) {
    throw new Error(`Telnyx API ${response.status}: ${text || response.statusText}`);
  }

  return data;
}

async function getCallControlApplication(connectionId: string): Promise<TelnyxCallControlApplication> {
  const payload = await telnyxRequest<{ data?: TelnyxCallControlApplication }>(
    `/call_control_applications/${encodeURIComponent(connectionId)}`,
  );

  return payload.data || {};
}

async function listOutboundVoiceProfiles(): Promise<TelnyxOutboundVoiceProfile[]> {
  const payload = await telnyxRequest<{ data?: TelnyxOutboundVoiceProfile[] }>(
    "/outbound_voice_profiles?page[size]=100",
  );

  return Array.isArray(payload.data) ? payload.data : [];
}

async function createOutboundVoiceProfile(name: string): Promise<TelnyxOutboundVoiceProfile> {
  const payload = await telnyxRequest<{ data?: TelnyxOutboundVoiceProfile }>("/outbound_voice_profiles", {
    method: "POST",
    body: JSON.stringify({
      name,
      enabled: true,
      service_plan: "global",
      traffic_type: "conversational",
      usage_payment_method: "rate-deck",
    }),
  });

  return payload.data || {};
}

async function assignOutboundVoiceProfile(connectionId: string, outboundVoiceProfileId: string) {
  const app = await getCallControlApplication(connectionId);
  const outbound = app.outbound || {};

  await telnyxRequest(`/call_control_applications/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      outbound: {
        ...outbound,
        outbound_voice_profile_id: outboundVoiceProfileId,
      },
    }),
  });

  return getCallControlApplication(connectionId);
}

export async function POST(request: Request) {
  try {
    await ensureMasterAdmin();
    requireMaster(request);

    const payload = (await request.json().catch(() => ({}))) as {
      connectionId?: string;
      profileName?: string;
    };

    const connectionId = String(payload.connectionId || process.env.TELNYX_CONNECTION_ID || "").trim();
    const profileName = String(payload.profileName || "Gloria Production").trim() || "Gloria Production";

    if (!connectionId) {
      return NextResponse.json({ error: "TELNYX_CONNECTION_ID fehlt." }, { status: 400 });
    }

    const currentApp = await getCallControlApplication(connectionId);
    const currentProfileId = currentApp.outbound?.outbound_voice_profile_id?.trim();

    let profile = (await listOutboundVoiceProfiles()).find((entry) => entry.name?.trim() === profileName);

    if (!profile) {
      profile = await createOutboundVoiceProfile(profileName);
    }

    const profileId = profile.id?.trim();
    if (!profileId) {
      throw new Error("Telnyx hat keine gueltige Outbound-Voice-Profile-ID zurueckgegeben.");
    }

    const updatedApp =
      currentProfileId === profileId ? currentApp : await assignOutboundVoiceProfile(connectionId, profileId);

    return NextResponse.json({
      ok: true,
      connectionId,
      applicationName: updatedApp.application_name || currentApp.application_name || null,
      outboundVoiceProfile: {
        id: profileId,
        name: profile.name || profileName,
        enabled: profile.enabled ?? true,
        servicePlan: profile.service_plan || null,
        trafficType: profile.traffic_type || null,
        usagePaymentMethod: profile.usage_payment_method || null,
      },
      assignedOutboundVoiceProfileId: updatedApp.outbound?.outbound_voice_profile_id || null,
      alreadyAssigned: currentProfileId === profileId,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
    }

    if (error instanceof Error && error.message === "FORBIDDEN") {
      return NextResponse.json({ error: "Keine Berechtigung." }, { status: 403 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Telnyx-Reparatur fehlgeschlagen." },
      { status: 500 },
    );
  }
}
