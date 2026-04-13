import { NextRequest, NextResponse } from "next/server";
import { deleteReport, getDashboardData } from "@/lib/storage";

export async function GET() {
  const data = await getDashboardData();
  return NextResponse.json(data);
}

export async function DELETE(request: NextRequest) {
  const reportId = request.nextUrl.searchParams.get("reportId");

  if (!reportId) {
    return NextResponse.json({ error: "reportId fehlt." }, { status: 400 });
  }

  await deleteReport(reportId);
  return NextResponse.json({ ok: true });
}
