import { NextResponse } from "next/server";
import { getDashboardData } from "@/lib/storage";

function csvEscape(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function formatDatePart(date: Date) {
  const day = `${date.getDate()}`.padStart(2, "0");
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatTimePart(date: Date) {
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

export async function GET() {
  const data = await getDashboardData();
  const appointments = data.reports.filter((report) => report.appointmentAt);

  const header = [
    "Subject",
    "Start Date",
    "Start Time",
    "End Date",
    "End Time",
    "All Day Event",
    "Description",
    "Location",
    "Private",
  ];

  const rows = appointments.map((report) => {
    const start = new Date(report.appointmentAt as string);
    const end = new Date(start.getTime() + 30 * 60 * 1000);

    return [
      csvEscape(`Beratungstermin ${report.company}`),
      csvEscape(formatDatePart(start)),
      csvEscape(formatTimePart(start)),
      csvEscape(formatDatePart(end)),
      csvEscape(formatTimePart(end)),
      csvEscape("False"),
      csvEscape(`${report.topic} | ${report.summary}`),
      csvEscape("Telefontermin / Agentur Duic"),
      csvEscape("False"),
    ].join(",");
  });

  const csv = [header.join(","), ...rows].join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="gloria-outlook-termine.csv"',
    },
  });
}
