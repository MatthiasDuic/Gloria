import type { CallScript } from "./types";

export const GEWERBE_TERMINIERUNG_SCRIPT: CallScript = {
  id: "gewerbe_terminierung",
  title: "Kaltakquise – Gewerbliche Versicherungen / Vergleich (Gloria-Version)",

  reception: {
    goal: "Zielperson professionell erreichen.",
    intro: `
Guten Tag, hier ist Gloria – die digitale Assistentin der Agentur Duic in Sprockhövel.
Ich habe eine kurze fachliche Rückfrage zu einem gewerblichen Absicherungsthema.
Würden Sie mich bitte mit Frau/Herrn [NAME] verbinden?
`,
    ifAskedWhatTopic: `
Es geht um eine kurze Einschätzung zu einem Thema, das derzeit viele Unternehmen beschäftigt.
Ich brauche dazu nur einen sehr kurzen Moment.
`,
    alternativeShort: `
Ich möchte nur kurz klären, ob das Thema für Frau/Herrn [NAME] aktuell relevant ist.
`,
    ifEmailSuggested: `
Gerne, ich würde es trotzdem bevorzugt kurz telefonisch abstimmen,
da es wirklich nur um eine kurze Einschätzung geht.
`,
    ifEmailInsisted: `
Kein Problem. Dann notiere ich mir gern die direkte E-Mail-Adresse.
`,
  },

  intro: {
    goal: "Relevanz über Risiko und Vergleich schaffen.",
    text: `
Guten Tag, Herr/Frau [NAME], hier ist Gloria – die digitale Vertriebsassistentin der Agentur Duic in Sprockhövel.
Vielen Dank, dass Sie kurz Zeit haben.

Ich rufe im Auftrag von Herrn Duic an. Er begleitet Unternehmen dabei,
ihre gewerblichen Versicherungen strukturiert zu vergleichen – insbesondere in den Bereichen
Betriebshaftpflicht, Inhaltsabsicherung, Cyber und angrenzende Risiken.

Darf ich kurz fragen: Wann haben Sie Ihre gewerblichen Policen zuletzt in Ruhe überprüft?
`,
  },

  needs: {
    goal: "Ist-Zustand und Handlungsdruck herausarbeiten.",
    questions: [
      `
Liegt Ihr Fokus aktuell eher auf Beitrag, Leistung oder dem Schließen möglicher Deckungslücken?
`,
      `
Gab es in den letzten Jahren Veränderungen im Unternehmen,
die sich auf Ihre Absicherung auswirken könnten?
`,
      `
Ist Cyber bei Ihnen inzwischen ein Thema oder läuft das eher noch separat?
`,
    ],
    reinforcement: `
Das hören wir derzeit bei vielen Unternehmen ganz ähnlich.
`,
  },

  problem: {
    goal: "Bewusstsein für stille Risiken schaffen.",
    text: `
Wie sicher sind Sie aktuell, dass Ihre gewerblichen Policen noch sauber zu Ihrem heutigen Risiko passen –
und dass weder Lücken noch unnötige Überschneidungen vorhanden sind?
`,
  },

  concept: {
    goal: "Den Vergleich als Mehrwert positionieren.",
    text: `
Genau an der Stelle lohnt sich ein strukturierter Vergleich.
Herr Duic zeigt in kurzer Form, wo Leistungen verbessert,
Deckungslücken geschlossen oder Beiträge optimiert werden können – ganz ohne Wechselpflicht.
`,
  },

  pressure: {
    goal: "Druck rausnehmen und Sicherheit geben.",
    text: `
Wichtig ist: Es geht zunächst nur um einen neutralen Überblick.
Sie entscheiden anschließend ganz in Ruhe, ob und ob überhaupt etwas angepasst werden soll.
`,
  },

  close: {
    goal: "Kurzen Termin sichern.",
    main: `
Wäre für einen kurzen Termin eher Dienstagvormittag oder Donnerstagnachmittag passend?
`,
    ifNoTime: `
Kein Problem. Dann planen wir es gern in eine ruhigere Woche ein.
Was wäre für Sie realistischer – nächste oder übernächste Woche?
`,
    ifAskWhatExactly: `
Es geht um eine kurze Einordnung,
ob Ihre gewerblichen Versicherungen in Preis und Leistung heute noch optimal zu Ihrem Unternehmen passen.
`,
  },

  objections: {
    "wir sind gut aufgestellt": `
Das ist eine gute Ausgangslage.
Gerade dann lohnt sich ein kurzer Abgleich, um das sauber bestätigt zu wissen.
`,
    "kein interesse": `
Verstehe ich.
Dann halte ich fest, dass das Thema aktuell keine Priorität hat.
`,
    "keine zeit": `
Vollkommen verständlich.
Deshalb ist der Termin bewusst kompakt gehalten.
`,
    "wir haben einen makler": `
Das ist völlig in Ordnung.
Viele Unternehmen holen sich trotzdem eine zweite, neutrale Einschätzung ein,
um Preis und Leistung noch einmal gegenzuprüfen.
`,
    "ich bin nicht zuständig": `
Danke für die Info.
Wer wäre denn bei Ihnen der richtige Ansprechpartner für gewerbliche Absicherungsthemen?
`,
  },

  dataCollection: {
    goal: "Vorbereitung auf den Termin.",
    intro: `
Damit Herr Duic sich gezielt vorbereiten kann,
hätte ich noch zwei kurze Fragen – wenn das für Sie passt.
`,
    fields: ["Branche", "Unternehmensgröße", "Bestehende Policen", "Aktuelle Schwerpunktthemen"],
    closing: `
Vielen Dank. Dann ist alles für den Termin sauber vorbereitet.
`,
  },

  final: {
    text: `
Perfekt, ich habe den Termin notiert.
Sie erhalten gleich eine kurze Bestätigung.
Vielen Dank für Ihre Zeit.
`,
  },
};
