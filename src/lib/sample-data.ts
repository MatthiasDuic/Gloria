import type { CallReport, Lead, ScriptConfig } from "./types";

export const defaultScripts: ScriptConfig[] = [
  {
    id: "skript-bkv",
    topic: "betriebliche Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich hoffe, ich störe Sie gerade nicht. Viele Unternehmen nutzen die betriebliche Krankenversicherung inzwischen gezielt, um Fachkräfte leichter zu gewinnen und zu binden. Bevor wir starten: Dürfte ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Mich würde kurz interessieren: Welche Benefits bieten Sie Ihren Mitarbeitenden heute schon an, und ist Mitarbeiterbindung bei Ihnen gerade ein wichtiges Thema?",
    objectionHandling:
      "Das kann ich gut nachvollziehen. Genau deshalb schauen viele Unternehmen zuerst ganz unverbindlich in 15 Minuten darauf, welche Modelle wirklich sinnvoll sind und was budgetseitig gut darstellbar wäre.",
    close:
      "Wenn Sie mögen, reserviere ich Ihnen direkt einen kurzen Termin mit Herrn Duic – passt Ihnen eher ein Vormittag oder ein Nachmittag besser?",
  },
  {
    id: "skript-bav",
    topic: "betriebliche Altersvorsorge",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Ich melde mich kurz zum Thema betriebliche Altersvorsorge, weil viele Arbeitgeber hier nach verständlichen und attraktiven Lösungen suchen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wie handhaben Sie die bAV aktuell bei neuen und bestehenden Mitarbeitenden, und gibt es dabei Punkte, die Sie gern einfacher oder attraktiver aufstellen würden?",
    objectionHandling:
      "Verstehe. Häufig reicht schon ein kurzer Blick von außen, um Fördermöglichkeiten, Arbeitgeberaufwand und die Verständlichkeit für Mitarbeitende deutlich besser einzuordnen.",
    close:
      "Gern würde ich Ihnen dafür einen kompakten Termin mit Herrn Duic reservieren – was passt bei Ihnen meist besser, eher Anfang oder eher Ende der Woche?",
  },
  {
    id: "skript-gewerbe",
    topic: "gewerbliche Versicherungen",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an, weil viele Unternehmen ihre gewerblichen Versicherungen momentan neu vergleichen, um Preis und Leistung sauber abzugleichen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wann haben Sie Ihre gewerblichen Policen zuletzt in Ruhe verglichen – vor allem bei Betriebshaftpflicht, Inhalts- oder Cyberabsicherung?",
    objectionHandling:
      "Das ist absolut verständlich. Ein kurzer Vergleich zeigt oft schon, ob Deckungslücken bestehen oder ob Beiträge günstiger und Leistungen gleichzeitig besser darstellbar wären – ganz ohne direkten Wechselzwang.",
    close:
      "Wenn es für Sie passt, sichere ich Ihnen gern einen unverbindlichen Termin mit Herrn Duic – welcher Tag wäre dafür grundsätzlich angenehm?",
  },
  {
    id: "skript-pkv",
    topic: "private Krankenversicherung",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an. Wir haben ein Konzept entwickelt, mit dem sich Krankenversicherungsbeiträge im Alter planbarer und stabiler aufstellen lassen. Denn egal ob gesetzlich oder privat versichert: Die Beiträge steigen meist Jahr für Jahr. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Darf ich kurz fragen: Sind Sie derzeit gesetzlich oder privat versichert, und ist das Thema Beitragsstabilität im Alter für Sie grundsätzlich interessant?",
    objectionHandling:
      "Das kann ich gut verstehen. Genau deshalb geht es im Termin nicht um einen schnellen Abschluss, sondern um eine kurze Einordnung, wie sich Beiträge langfristig besser planen lassen. Wenn Sie die Details gerade nicht parat haben, reicht zunächst auch die kurze Info, ob Sie sich derzeit grundsätzlich als gesund bezeichnen würden.",
    close:
      "Wenn es für Sie passt, reserviere ich Ihnen gern einen kurzen Termin mit Herrn Duic. Für die Vorbereitung klären wir dann nur noch ein paar Rahmendaten.",
  },
  {
    id: "skript-energie",
    topic: "Energie",
    opener:
      "Guten Tag, hier ist Gloria, die digitale Vertriebsassistentin. Ich rufe im Auftrag von Herrn Matthias Duic an und melde mich kurz zum Thema gewerbliche Strom- und Gasoptimierung, weil sich dort häufig schnell Einsparpotenziale zeigen. Darf ich das Gespräch zu Schulungs- und Qualitätszwecken aufzeichnen?",
    discovery:
      "Wie zufrieden sind Sie aktuell mit Ihren gewerblichen Strom- und Gaskonditionen, und steht bei Ihnen in nächster Zeit eine Verlängerung oder Neuverhandlung an?",
    objectionHandling:
      "Verstehe gut. Genau deshalb nutzen viele Unternehmen einen kurzen Vergleich, um ohne großen Aufwand Transparenz über mögliche Einsparungen und bessere Konditionen zu bekommen.",
    close:
      "Wenn Sie möchten, organisiere ich Ihnen direkt einen kurzen Vergleichstermin mit Herrn Duic – wann würde es Ihnen zeitlich am besten passen?",
  },
];

export const defaultLeads: Lead[] = [
  {
    id: "lead-1001",
    company: "Bergische Metallbau GmbH",
    contactName: "Frau Klein",
    phone: "+49 2339 123450",
    email: "klein@bergische-metallbau.de",
    topic: "betriebliche Krankenversicherung",
    note: "50 Mitarbeitende, stark im Recruiting aktiv.",
    status: "wiedervorlage",
    nextCallAt: "2026-04-11T09:30:00.000Z",
    attempts: 2,
  },
  {
    id: "lead-1002",
    company: "Ruhr IT Services",
    contactName: "Herr Kramer",
    phone: "+49 201 555990",
    email: "kramer@ruhr-it.de",
    topic: "gewerbliche Versicherungen",
    note: "Cyber-Risiko ansprechen.",
    status: "termin",
    attempts: 1,
  },
  {
    id: "lead-1003",
    company: "Nordstern Logistik",
    contactName: "Frau Yildiz",
    phone: "+49 2302 777100",
    email: "yildiz@nordstern-logistik.de",
    topic: "Energie",
    note: "Stromvertrag endet in 4 Monaten.",
    status: "neu",
    attempts: 0,
  },
];

export const defaultReports: CallReport[] = [
  {
    id: "report-9001",
    leadId: "lead-1002",
    company: "Ruhr IT Services",
    contactName: "Herr Kramer",
    topic: "gewerbliche Versicherungen",
    summary:
      "Interesse an Vergleich der Betriebshaftpflicht und Cyberdeckung. Termin für Unterlagenbesprechung vereinbart.",
    outcome: "Termin",
    conversationDate: "2026-04-09T08:40:00.000Z",
    appointmentAt: "2026-04-14T09:00:00.000Z",
    attempts: 1,
    recordingConsent: true,
    recordingUrl: "https://example.com/recordings/report-9001.mp3",
    emailedTo: "Matthias.duic@agentur-duic-sprockhoevel.de",
  },
  {
    id: "report-9002",
    leadId: "lead-1001",
    company: "Bergische Metallbau GmbH",
    contactName: "Frau Klein",
    topic: "betriebliche Krankenversicherung",
    summary:
      "Kein finaler Termin, Rückruf auf Samstagvormittag erbeten.",
    outcome: "Wiedervorlage",
    conversationDate: "2026-04-08T11:10:00.000Z",
    nextCallAt: "2026-04-11T09:30:00.000Z",
    attempts: 2,
    recordingConsent: false,
    emailedTo: "Matthias.duic@agentur-duic-sprockhoevel.de",
  },
];
