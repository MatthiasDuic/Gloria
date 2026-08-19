import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";
import { listCallTranscriptEventsFromPostgres } from "@/lib/report-db";
import { getSessionUserFromRequest } from "@/lib/request-auth";

interface QualityMetrics {
  totalCalls: number;
  successRate: number; // % of calls with "Termin" outcome
  appointmentRate: number; // % of calls with appointment confirmed
  abortRate: number; // % of calls that were "Gespraech abgebrochen"
  averageCallDurationMs: number;
  reportCompletionRate: number; // % of calls with conversationOccurred=true
  topicSuccessRates: Record<string, { total: number; terminated: number; rate: number }>;
  conversationEventCounts: {
    clearRejections: number;
    customerQuestions: number;
    objections: number;
    uncertainties: number;
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const sessionUser = getSessionUserFromRequest(request);
  if (!sessionUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const dashboard = await getDashboardData({ userId: sessionUser.id, role: "user" });
    const { leads, reports } = dashboard;

    // Basic call metrics
    const totalCalls = reports.length;
    if (totalCalls === 0) {
      return NextResponse.json({
        totalCalls: 0,
        successRate: 0,
        appointmentRate: 0,
        abortRate: 0,
        averageCallDurationMs: 0,
        reportCompletionRate: 0,
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

    // Average call duration (from report timestamps — rough estimate)
    const durations: number[] = [];
    for (let i = 0; i < reports.length - 1; i++) {
      const current = new Date(reports[i].conversationDate || "").getTime();
      const next = new Date(reports[i + 1].conversationDate || "").getTime();
      if (current > 0 && next > 0) {
        const diff = Math.abs(current - next);
        if (diff < 5 * 60 * 1000) {
          // Assume calls don't exceed 5 minutes
          durations.push(diff);
        }
      }
    }
    const averageCallDurationMs = durations.length > 0 
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : 0;

    // Conversation event analysis
    const eventCounts = {
      clearRejections: 0,
      customerQuestions: 0,
      objections: 0,
      uncertainties: 0,
    };
    
    // Note: Approximation based on available report fields.
    // For detailed event analysis, would need full conversation event records.
    eventCounts.clearRejections = rejectedCount;
    eventCounts.uncertainties = reports.filter(r => !r.summary || r.summary.length < 20).length;

    const metrics: QualityMetrics = {
      totalCalls,
      successRate: totalCalls > 0 ? (terminatedCount / totalCalls) * 100 : 0,
      appointmentRate: totalCalls > 0 ? (appointmentCount / totalCalls) * 100 : 0,
      abortRate: totalCalls > 0 ? (rejectedCount / totalCalls) * 100 : 0,
      averageCallDurationMs,
      reportCompletionRate: totalCalls > 0 ? (conversationOccurredCount / totalCalls) * 100 : 0,
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
