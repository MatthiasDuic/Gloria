// One-off generator for the customer import sample Excel file (public/vorlage-kundenimport.xlsx).
// Run with: node scripts/generate-import-template.mjs
import * as XLSX from "xlsx";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const header = [
  "customerOwner",
  "customerKind",
  "company",
  "contactName",
  "phone",
  "additionalPhones",
  "email",
  "birthDate",
  "addressStreet",
  "addressPostalCode",
  "addressCity",
  "addressCountry",
  "products",
  "topic",
  "note",
  "nextCallAt",
];

const rows = [
  [
    "Agentur-Duic",
    "firma",
    "Musterbau GmbH",
    "Herr Neumann",
    "+492339123456",
    "+492339123457; +491701234567",
    "info@musterbau.de",
    "",
    "Beispielweg 12",
    "42103",
    "Wuppertal",
    "Deutschland",
    "gewerbliche Versicherungen; Energie",
    "gewerbliche Versicherungen",
    "Jahresgespräch, Ansprechpartner bevorzugt vormittags erreichbar.",
    "",
  ],
  [
    "BarmeniaGothaer",
    "privat",
    "",
    "Max Mustermann",
    "+491701112233",
    "+492021234567",
    "max.mustermann@email.de",
    "15.03.1985",
    "Musterstraße 4",
    "40210",
    "Düsseldorf",
    "Deutschland",
    "private Krankenversicherung",
    "private Krankenversicherung",
    "Bestandskunde, Rückruf nach 17 Uhr gewünscht.",
    "",
  ],
];

const worksheet = XLSX.utils.aoa_to_sheet([header, ...rows]);
worksheet["!cols"] = header.map((h) => ({ wch: Math.max(h.length + 2, 18) }));

const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, "Kundenimport");

const outPath = path.join(__dirname, "..", "public", "vorlage-kundenimport.xlsx");
const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
writeFileSync(outPath, buffer);

console.log(`Vorlage geschrieben nach: ${outPath}`);
