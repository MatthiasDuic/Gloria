import type { CallScript } from "./types";

export const BAV_TERMINIERUNG_SCRIPT: CallScript = {
  id: "bav_terminierung",
  title: "Kaltakquise – Betriebliche Altersvorsorge (Gloria-Version)",

  reception: {
    goal: "Neutral verbinden lassen, ohne sofort in Details zu gehen.",
    intro: `
Guten Tag, hier ist Gloria – die digitale Assistentin der Agentur Duic in Sprockhövel.
Ich habe eine kurze fachliche Rückfrage für Frau/Herrn [NAME].
Würden Sie mich bitte kurz verbinden?
`,
    ifAskedWhatTopic: `
Es geht um ein Thema, das viele Unternehmen aktuell im Bereich Mitarbeitendenbindung beschäftigt.
Ich brauche dazu nur eine kurze fachliche Einschätzung.
`,
    alternativeShort: `
Ich möchte nur kurz prüfen, ob das Thema für Frau/Herrn [NAME] relevant ist.
Es dauert wirklich nicht länger als 30 Sekunden.
`,
    ifEmailSuggested: `
Gerne, allerdings ist es nur eine kurze Rückfrage.
Telefonisch lässt sich das meist in wenigen Sekunden klären.
`,
    ifEmailInsisted: `
Kein Problem.
Dann bräuchte ich bitte die direkte E-Mail-Adresse von Frau/Herrn [NAME],
damit die Anfrage gezielt ankommt.
`,
  },

  intro: {
    goal: "Relevanz aufbauen und Interesse für einen kurzen Termin erzeugen.",
    text: `
Guten Tag, Herr/Frau [NAME], hier ist Gloria – die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel.
Vielen Dank, dass Sie kurz drangehen.

Ich rufe im Auftrag von Herrn Duic an. Er begleitet Unternehmen dabei,
Benefits und Vorsorgelösungen für Mitarbeitende verständlich und attraktiv aufzustellen.
Gerade bei der betrieblichen Altersvorsorge geht es oft darum,
Mitarbeitende stärker zu binden und gleichzeitig vorhandene Modelle sinnvoller zu strukturieren.

Wie ist das Thema bAV aktuell bei Ihnen aufgestellt?
`,
  },

  needs: {
    goal: "Den Ist-Stand sichtbar machen.",
    questions: [
      `
Nutzen Sie die bAV heute eher aktiv zur Mitarbeiterbindung oder läuft sie eher nebenbei mit?
`,
      `
Gibt es dabei Punkte, die Sie gern verständlicher oder einfacher gestalten würden?
`,
      `
Wie gut wird das Thema von Ihren Mitarbeitenden aktuell angenommen?
`,
    ],
    reinforcement: `
Das ist ein typisches Bild, das wir aktuell bei vielen Unternehmen sehen.
`,
  },

  problem: {
    goal: "Fehlende Transparenz oder Aktivierung bewusst machen.",
    text: `
Wie sicher sind Sie aktuell, dass Ihre bestehende Lösung sowohl für Ihr Unternehmen
als auch für Ihre Mitarbeitenden wirklich optimal aufgestellt ist?
Und wird die bAV bei Ihnen eher als echter Benefit wahrgenommen oder eher als Pflichtlösung?
`,
  },

  concept: {
    goal: "Neugier wecken, ohne in Fachberatung abzurutschen.",
    text: `
Genau dort setzt eine gute bAV-Beratung an.
Herr Duic zeigt Unternehmen kompakt auf,
wie sich Arbeitgeberattraktivität, Fördermöglichkeiten und Verständlichkeit sauber zusammenbringen lassen.

Dafür reichen in der Regel 10 bis 15 Minuten völlig aus.
`,
  },

  pressure: {
    goal: "Vertrauen und Leichtigkeit erzeugen.",
    text: `
Ganz entspannt: Es geht nicht darum, sofort etwas umzusetzen.
Zuerst schauen wir nur gemeinsam, ob es überhaupt sinnvolle Optimierungspotenziale gibt.
`,
  },

  close: {
    goal: "Kurztermin vereinbaren.",
    main: `
Wann passt es Ihnen für einen kurzen Termin besser – eher am Vormittag oder eher am Nachmittag?
`,
    ifNoTime: `
Kein Problem.
Wäre kommende Woche oder die Woche darauf für Sie passender?
`,
    ifAskWhatExactly: `
Es geht darum, wie Sie die betriebliche Altersvorsorge
für Ihr Unternehmen verständlicher, attraktiver und gegebenenfalls effizienter aufstellen können.
Das lässt sich in einem kurzen Gespräch am besten einordnen.
`,
  },

  objections: {
    "wir haben schon etwas": `
Das ist oft eine gute Grundlage.
Trotzdem lohnt sich häufig ein kurzer Blick, ob Kommunikation, Förderungen oder Struktur noch verbessert werden können.
`,
    "kein interesse": `
Verstehe ich.
Dann halte ich gern fest, dass das Thema aktuell keine Priorität hat.
`,
    "keine zeit": `
Das kann ich nachvollziehen.
Gerade deshalb ist der Termin bewusst kurz gehalten – 10 bis 15 Minuten reichen völlig aus.
`,
    "zu kompliziert": `
Genau deshalb ist der Austausch sinnvoll.
Herr Duic erklärt das Thema sehr verständlich und ohne Fachchinesisch.
`,
    "die mitarbeiter nutzen es nicht": `
Das ist ein typischer Punkt.
Oft liegt es weniger am Thema selbst als an der Aufbereitung und Kommunikation.
`,
    "ich bin nicht zuständig": `
Alles klar, danke Ihnen.
Wer ist denn bei Ihnen der passende Ansprechpartner für Vorsorge- und Benefit-Themen?
`,
  },

  dataCollection: {
    goal: "Terminvorbereitung.",
    intro: `
Damit Herr Duic sich passend vorbereiten kann,
hätte ich noch zwei kurze Fragen – wenn das für Sie in Ordnung ist.
`,
    fields: ["Mitarbeiteranzahl", "Branche", "Bestehende bAV-Lösung", "Aktuelle Herausforderung"],
    closing: `
Perfekt, vielen Dank. Dann kann Herr Duic das Gespräch gezielt vorbereiten.
`,
  },

  final: {
    text: `
Perfekt, ich trage den Termin ein.
Sie erhalten im Anschluss eine kurze Bestätigung.
Vielen Dank für Ihre Zeit.
`,
  },
};
