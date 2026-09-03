import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";
import { listCallTranscriptEventsFromPostgres } from "@/lib/report-db";
import { getSessionUserFromRequest } from "@/lib/request-auth";

interface QualityMetrics {
  totalCalls: number;
  successRate: number;
  appointmentRate: number;
  abortRate: number;
  reportCompletionRate: number;
  responseLatency: { measuredResponses: number; medianMs: number; p95Ms: number; slowResponses: number };
  dialogueQuality: { callsWithMultipleQuestions: number; callsWithRepeatedQuestions: number };
  rejectionReasons: Record<string, number>;
  lostPhases: Record<string, number>;
  topicSuccessRates: Record<string, { total: number; terminated: number; rate: number }>;
  conversationEventCounts: {
    clearRejections: number;
    customerQuestions: number;
    objections: number;
    uncertainties: number;
  };
}

type TranscriptEvent = Awaited<ReturnType<typeof listCallTranscriptEventsFromPostgres>>[number];

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/[^a-zäöüß0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function classifyRejectionReason(text: string): string | undefined {
  if (/nicht\s+(?:mehr\s+)?anrufen|keine\s+(?:werbe)?anrufe|streichen\s+mich/i.test(text)) return "Keine Werbeanrufe";
  if (/keine?\s+zeit|gerade\s+schlecht|unpassend|muss\s+gleich\s+weg/i.test(text)) return "Keine Zeit";
  if (/berater|makler|bereits\s+(?:versorgt|beraten)/i.test(text)) return "Bereits versorgt";
  if (/zu\s+teuer|kein\s+budget|kosten/i.test(text)) return "Budget / Kosten";
  if (/falsch|nicht\s+zuständig|nicht\s+der\s+richtige/i.test(text)) return "Falscher Ansprechpartner";
  if (/kein\s+interesse|nicht\s+interessiert|kommt\s+nicht\s+infrage/i.test(text)) return "Kein Interesse";
  return undefined;
}

function evaluateTranscript(events: TranscriptEvent[]) {
  const responseLatencies = events
    .filter((event) => event.speaker === "Gloria" && typeof event.latencyMs === "number")
    .map((event) => event.latencyMs as number);
  const seenQuestions = new Set<string>();
  let hasMultipleQuestions = false;
  let hasRepeatedQuestion = false;
  const rejectionReasons: string[] = [];
  let lastPhase: string | undefined;

  for (const event of events) {
    if (event.phase) lastPhase = event.phase;
    if (event.speaker === "Interessent") {
      const reason = classifyRejectionReason(event.text);
      if (reason) rejectionReasons.push(reason);
      continue;
    }
    const questions = event.text.match(/[^?]+\?/g) || [];
    if (questions.length > 1) hasMultipleQuestions = true;
    for (const question of questions) {
      const normalized = normalizeQuestion(question);
      if (!normalized) continue;
      if (seenQuestions.has(normalized)) hasRepeatedQuestion = true;
      seenQuestions.add(normalized);
    }
  }

  return { responseLatencies, hasMultipleQuestions, hasRepeatedQuestion, rejectionReasons, lastPhase };
}

export async function GET(request: Request): Promise<NextResponse> {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const dashboard = await getDashboardData({ userId: sessionUser.id, role: "user" });
    const { reports } = dashboard;

    // Basic call metrics
    const totalCalls = reports.length;
    if (totalCalls === 0) {
      return NextResponse.json({
        totalCalls: 0,
        successRate: 0,
        appointmentRate: 0,
        abortRate: 0,
        reportCompletionRate: 0,
        responseLatency: { measuredResponses: 0, medianMs: 0, p95Ms: 0, slowResponses: 0 },
        dialogueQuality: { callsWithMultipleQuestions: 0, callsWithRepeatedQuestions: 0 },
        rejectionReasons: {},
        lostPhases: {},
        topicSuccessRates: {},
        conversationEventCounts: {
          clearRejections: 0,
          customerQuestions: 0,
          objections: 0,
          uncertainties: 0,
        },
      } as QualityMetrics);
    }

    // Outcome analysis
    const terminatedCount = reports.filter(r => r.outcome === "Termin").length;
    const appointmentCount = reports.filter(r => r.appointmentAt).length;
    const rejectedCount = reports.filter(r => r.outcome === "Absage").length;
    const abortedCount = reports.filter(r => r.outcome === "Gespräch abgebrochen").length;
    const conversationOccurredCount = reports.filter(r => r.summary && r.summary.length > 10).length;

    // Topic-specific success rates
    const topicSuccessRates: Record<string, { total: number; terminated: number; rate: number }> = {};
    for (const topic of new Set(reports.map(r => r.topic))) {
      const topicReports = reports.filter(r => r.topic === topic);
      const topicTerminated = topicReports.filter(r => r.outcome === "Termin").length;
      topicSuccessRates[topic] = {
        total: topicReports.length,
        terminated: topicTerminated,
        rate: topicReports.length > 0 ? (topicTerminated / topicReports.length) * 100 : 0,
      };
    }

    const transcriptByReport = await Promise.all(reports.map(async (report) => ({
      report,
      evaluation: report.callSid ? evaluateTranscript(await listCallTranscriptEventsFromPostgres(report.callSid)) : undefined,
    })));
    const responseLatencies = transcriptByReport.flatMap((entry) => entry.evaluation?.responseLatencies || []);
    const rejectionReasons: Record<string, number> = {};
    const lostPhases: Record<string, number> = {};
    let callsWithMultipleQuestions = 0;
    let callsWithRepeatedQuestions = 0;
    for (const entry of transcriptByReport) {
      const evaluation = entry.evaluation;
      if (!evaluation) continue;
      if (evaluation.hasMultipleQuestions) callsWithMultipleQuestions += 1;
      if (evaluation.hasRepeatedQuestion) callsWithRepeatedQuestions += 1;
      for (const reason of evaluation.rejectionReasons) rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      if (entry.report.outcome === "Absage" || entry.report.outcome === "Gespräch abgebrochen") {
        const phase = evaluation.lastPhase || "unbekannt";
        lostPhases[phase] = (lostPhases[phase] || 0) + 1;
      }
    }

    const eventCounts = {
      clearRejections: 0,
      customerQuestions: 0,
      objections: 0,
      uncertainties: 0,
    };
    
    eventCounts.clearRejections = rejectedCount;
    eventCounts.objections = Object.values(rejectionReasons).reduce((sum, count) => sum + count, 0);
    eventCounts.uncertainties = reports.filter(r => !r.summary || r.summary.length < 20).length;

    const metrics: QualityMetrics = {
      totalCalls,
      successRate: totalCalls > 0 ? (terminatedCount / totalCalls) * 100 : 0,
      appointmentRate: totalCalls > 0 ? (appointmentCount / totalCalls) * 100 : 0,
      abortRate: totalCalls > 0 ? (abortedCount / totalCalls) * 100 : 0,
      reportCompletionRate: totalCalls > 0 ? (conversationOccurredCount / totalCalls) * 100 : 0,
      responseLatency: {
        measuredResponses: responseLatencies.length,
        medianMs: percentile(responseLatencies, 0.5),
        p95Ms: percentile(responseLatencies, 0.95),
        slowResponses: responseLatencies.filter((latency) => latency > 2500).length,
      },
      dialogueQuality: { callsWithMultipleQuestions, callsWithRepeatedQuestions },
      rejectionReasons,
      lostPhases,
      topicSuccessRates,
      conversationEventCounts: eventCounts,
    };

    return NextResponse.json(metrics);
  } catch (error) {
    console.error("Quality metrics calculation failed", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Fehler bei der Metrik-Berechnung",
      },
      { status: 500 },
    );
  }
}
