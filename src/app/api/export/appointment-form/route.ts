import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/request-auth";
import { buildAppointmentFormInputFromReport, buildAppointmentFormPdf, getAppointmentFormFilename } from "@/lib/appointment-form";
import { getDashboardData } from "@/lib/storage";
import { listCallTranscriptEventsFromPostgres } from "@/lib/report-db";

export async function GET(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  const callSid = new URL(request.url).searchParams.get("callSid")?.trim();
  if (!callSid) {
    return NextResponse.json({ error: "Call-SID fehlt." }, { status: 400 });
  }

  const data = await getDashboardData({ userId: sessionUser.id, role: sessionUser.role });
  const report = data.reports.find((entry) => entry.callSid === callSid);
  if (!report) {
    return NextResponse.json({ error: "Report nicht gefunden." }, { status: 404 });
  }

  try {
    const transcriptEvents = await listCallTranscriptEventsFromPostgres(callSid);
    const input = buildAppointmentFormInputFromReport({ ...report, transcriptEvents });
    const pdf = await buildAppointmentFormPdf(input);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${getAppointmentFormFilename(input)}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF-Erstellung fehlgeschlagen.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const pdf = await buildAppointmentFormPdf({
      title: typeof payload.title === "string" ? payload.title : "Kundenterminbogen",
      topic: typeof payload.topic === "string" ? payload.topic : undefined,
      createdAt: typeof payload.createdAt === "string" ? payload.createdAt : new Date().toISOString(),
      appointmentDate: typeof payload.appointmentDate === "string" ? payload.appointmentDate : undefined,
      appointmentMode: typeof payload.appointmentMode === "string" ? payload.appointmentMode : undefined,
      location: typeof payload.location === "string" ? payload.location : undefined,
      advisor: typeof payload.advisor === "string" ? payload.advisor : undefined,
      contactName: typeof payload.contactName === "string" ? payload.contactName : undefined,
      birthDate: typeof payload.birthDate === "string" ? payload.birthDate : undefined,
      phone: typeof payload.phone === "string" ? payload.phone : undefined,
      email: typeof payload.email === "string" ? payload.email : undefined,
      company: typeof payload.company === "string" ? payload.company : undefined,
      insuranceStatus: typeof payload.insuranceStatus === "string" ? payload.insuranceStatus : undefined,
      healthInsurance: typeof payload.healthInsurance === "string" ? payload.healthInsurance : undefined,
      monthlyContribution: typeof payload.monthlyContribution === "string" ? payload.monthlyContribution : undefined,
      heightWeight: typeof payload.heightWeight === "string" ? payload.heightWeight : undefined,
      medication: typeof payload.medication === "string" ? payload.medication : undefined,
      diagnoses: typeof payload.diagnoses === "string" ? payload.diagnoses : undefined,
      therapy: typeof payload.therapy === "string" ? payload.therapy : undefined,
      hospitalizations: typeof payload.hospitalizations === "string" ? payload.hospitalizations : undefined,
      dentalAllergies: typeof payload.dentalAllergies === "string" ? payload.dentalAllergies : undefined,
      notes: typeof payload.notes === "string" ? payload.notes : undefined,
    });

    const filename = getAppointmentFormFilename({
      topic: typeof payload.topic === "string" ? payload.topic : undefined,
      title: typeof payload.title === "string" ? payload.title : "Kundenterminbogen",
    });

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "PDF-Erstellung fehlgeschlagen.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
