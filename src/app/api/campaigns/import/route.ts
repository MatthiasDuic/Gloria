import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { importLeadsFromCsv } from "@/lib/storage";
import { getSessionUserFromRequest } from "@/lib/request-auth";

export const runtime = "nodejs";

function isUploadFileLike(value: unknown): value is { name: string; arrayBuffer: () => Promise<ArrayBuffer> } {
  return Boolean(
    value &&
      typeof value === "object" &&
      "name" in value &&
      typeof (value as { name?: unknown }).name === "string" &&
      "arrayBuffer" in value &&
      typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function",
  );
}

function decodeCsvBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

  if (utf8.includes("\u0000")) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  }

  return utf8.replace(/^\uFEFF/, "");
}

function extractCsvFromWorkbook(bytes: Uint8Array): string {
  const workbook = XLSX.read(bytes, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return "";
  }

  const sheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
}

export async function POST(request: Request) {
  const sessionUser = getSessionUserFromRequest(request);

  if (!sessionUser) {
    return NextResponse.json({ error: "Nicht angemeldet." }, { status: 401 });
  }

  try {
    const contentType = (request.headers.get("content-type") || "").toLowerCase();

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      const requestedListName = String(form.get("listName") || "").trim();
      const requestedListId = String(form.get("listId") || "").trim();

      if (!isUploadFileLike(file)) {
        return NextResponse.json(
          { error: "Bitte eine CSV- oder Excel-Datei hochladen." },
          { status: 400 },
        );
      }

      const lowerName = file.name.toLowerCase();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let csvText = "";

      if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
        csvText = extractCsvFromWorkbook(bytes);
      } else if (lowerName.endsWith(".csv")) {
        csvText = decodeCsvBytes(bytes);
      } else {
        return NextResponse.json(
          { error: "Dateityp nicht unterstützt. Bitte CSV, XLSX oder XLS verwenden." },
          { status: 400 },
        );
      }

      if (!csvText.trim()) {
        return NextResponse.json(
          { error: "Die Datei enthält keine importierbaren Daten." },
          { status: 400 },
        );
      }

      const inferredListName = requestedListName || file.name.replace(/\.[^.]+$/, "").trim();
      const result = await importLeadsFromCsv(csvText, {
        listId: requestedListId || undefined,
        listName: inferredListName || undefined,
        userId: sessionUser.id,
      });
      return NextResponse.json(result);
    }

    const payload = (await request.json().catch(() => ({}))) as {
      csvText?: string;
      listName?: string;
      listId?: string;
    };

    if (!payload.csvText?.trim()) {
      return NextResponse.json(
        { error: "Bitte CSV-Inhalt mitsenden." },
        { status: 400 },
      );
    }

    const result = await importLeadsFromCsv(payload.csvText, {
      listId: payload.listId,
      listName: payload.listName,
      userId: sessionUser.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? `Upload fehlgeschlagen: ${error.message}`
            : "Upload fehlgeschlagen.",
      },
      { status: 500 },
    );
  }
}
