import assert from "node:assert/strict";
import test from "node:test";
import { advanceContactRouting, buildGatekeeperReason, buildRetryFarewell, classifyReceptionTransfer, createContactRoutingState, extractRetryTimePhrase, extractSuccessorName, isContactNoLongerAtCompany, isGatekeeperReasonQuestion, isGatekeeperUnavailable, mentionsRetryTime } from "./contact-routing-controller.js";

test("recognises the many real-world ways a receptionist says the person is unavailable", () => {
  for (const text of [
    "Herr Neumann ist gerade im Meeting.",
    "Er ist heute im Homeoffice.",
    "Herr Neumann sitzt in einer Besprechung.",
    "Der ist auf Geschäftsreise.",
    "Er ist in der Mittagspause.",
    "Herr Neumann ist schon im Feierabend.",
    "Er telefoniert gerade.",
    "Der Chef ist auf der Baustelle.",
    "Er ist beim Kunden.",
    "Herr Neumann kommt erst morgen wieder.",
  ]) {
    assert.equal(isGatekeeperUnavailable(text), true, text);
  }
  assert.equal(isGatekeeperUnavailable("Ja, Herr Neumann ist da, einen Moment."), false);
});

test("detects a contact who has left the company and extracts a named successor", () => {
  for (const text of [
    "Herr Neumann ist nicht mehr bei uns.",
    "Der arbeitet schon lange nicht mehr hier.",
    "Herr Neumann hat das Unternehmen verlassen.",
    "Herr Neumann ist in den Ruhestand gegangen.",
    "Einen Herrn Neumann gibt es hier nicht.",
    "Da sind Sie falsch verbunden.",
  ]) {
    assert.equal(isContactNoLongerAtCompany(text), true, text);
  }
  for (const text of ["Herr Neumann ist heute nicht mehr im Haus.", "Er ist gerade nicht da."]) {
    assert.equal(isContactNoLongerAtCompany(text), false, text);
  }
  assert.equal(extractSuccessorName("Das macht jetzt Frau Meier."), "Frau Meier");
  assert.equal(extractSuccessorName("Zuständig ist inzwischen Herr Schulz."), "Herr Schulz");
  assert.equal(extractSuccessorName("Frau Krause hat das übernommen."), "Frau Krause");
  assert.equal(extractSuccessorName("Ich verbinde Sie mit Herrn Peters."), "Herr Peters");
  assert.equal(extractSuccessorName("Das weiß ich nicht."), undefined);
});

test("treats handing over the receiver as a transfer in progress, not as a new request", () => {
  for (const text of [
    "Ich reiche Sie mal weiter.",
    "Ich übergebe an Herrn Neumann.",
    "Ich gebe Ihnen mal Herrn Neumann.",
    "Ich gebe den Hörer weiter.",
    "Moment, er kommt gleich.",
    "Bleiben Sie bitte dran.",
    "Ich hol Herrn Neumann.",
  ]) {
    assert.equal(classifyReceptionTransfer(text), "in_progress", text);
  }
  for (const text of ["Ich gebe Ihnen mal Herrn Neumanns Durchwahl.", "Bleiben Sie dran, ich hole einen Stift.", "Ich übergebe ihm die Nachricht."]) {
    assert.notEqual(classifyReceptionTransfer(text), "in_progress", text);
  }
});

test("turns receptionist availability hints into natural retry phrases", () => {
  assert.equal(extractRetryTimePhrase("Herr Neumann hat diese Woche noch Urlaub."), "nächste Woche");
  assert.equal(extractRetryTimePhrase("Er ist bis zum 20. im Urlaub."), "nach dem zwanzigsten");
  assert.equal(extractRetryTimePhrase("Er ist ab dem 3. wieder da."), "ab dem dritten");
  assert.equal(extractRetryTimePhrase("Er ist bis Ende des Monats weg."), "Anfang nächsten Monats");
  assert.equal(extractRetryTimePhrase("Versuchen Sie es Ende des Monats."), "Ende des Monats");
  assert.equal(buildRetryFarewell("Herr Neumann hat diese Woche noch Urlaub, frühestens nächste Woche."),
    "Vielen Dank. Dann versuche ich es nächste Woche erneut. Auf Wiederhören.");
});

test("recognizes initial recorded welcomes, hold music and advertising without starting a conversation", () => {
  let state = createContactRoutingState("Herr Neumann");
  for (const text of [
    "Herzlich willkommen bei Beispiel.",
    "Vielen Dank für Ihren Anruf.",
    "[Musik]",
    "Informieren Sie sich inzwischen über unsere günstigen Angebote.",
    "Ihr Anruf ist uns wichtig.",
  ]) {
    state = advanceContactRouting(state, text);
    assert.equal(state.stage, "waiting_for_transfer", text);
  }
  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("machine detection remains active after an apparent human greeting or confirmed decision maker", () => {
  for (const stage of ["confirming_decision_maker", "decision_maker"] as const) {
    const state = { ...createContactRoutingState("Herr Neumann"), stage };
    assert.equal(advanceContactRouting(state, "Bitte sprechen Sie nach dem Ton.").stage, "voicemail");
    assert.equal(advanceContactRouting(state, "Alle Mitarbeiter sind im Gespräch. Bitte warten Sie.").stage, "waiting_for_transfer");
  }
});

test("a new receptionist after a transfer is not dismissed for the previous receptionist's request", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Neumann"), stage: "waiting_for_transfer",
    gatekeeperRequestMade: true, gatekeeperReasonGiven: true,
  }, "Empfang, hier ist Frau Müller. Guten Tag.");
  assert.equal(state.stage, "gatekeeper");
  assert.equal(state.gatekeeperRequestMade, false);
  assert.equal(state.gatekeeperReasonGiven, false);
});

test("uses the healthcare contribution reason at reception without disclosing a private insurance status", () => {
  const reason = buildGatekeeperReason("private Krankenversicherung");
  assert.equal(reason, "Es geht um die langfristige Beitragsentwicklung in der Gesundheitsversorgung.");
  assert.doesNotMatch(reason, /privat|krankenversicherung/i);
  assert.equal(buildGatekeeperReason("PKV"), "Es geht um die langfristige Beitragsentwicklung in der Gesundheitsversorgung.");
  assert.equal(buildGatekeeperReason("Kampagne Energie"), "Es geht um ein kurzes Anliegen für die zuständige Person.");
  assert.equal(
    buildGatekeeperReason("Kampagne Energie", undefined, "Ich habe eine Frage zum Thema betriebliche Altersvorsorge."),
    "Es geht um das Thema betriebliche Altersvorsorge.",
  );
});

test("uses a speakable campaign objective as the reception reason instead of an internal campaign name", () => {
  const objective = "Es geht um ein Kennenlernen zur Zukunft des Versicherungsvertriebs. Vereinbare einen Termin.";
  assert.equal(
    buildGatekeeperReason("Recruiting", objective),
    "Es geht um ein Kennenlernen zur Zukunft des Versicherungsvertriebs.",
  );
  assert.equal(buildGatekeeperReason("Recruiting", "Erfrage den Personalbedarf und vereinbare einen Termin."), null);
  assert.equal(buildGatekeeperReason("Recruiting", "Es geht um die Zusammenarbeit mit Herrn Dr. Neumann im Vertrieb."), null);
});

test("recognizes a gatekeeper's reason question without confusing availability or refusal", () => {
  for (const text of [
    "Worum geht es?", "Um was geht es denn?", "Was ist der Anlass?", "Was ist denn Ihr Anliegen?",
    "Weshalb rufen Sie an?", "Darf ich fragen, worum es geht?", "Um was handelt es sich?",
    "Was genau ist der Grund Ihres Anrufs?",
  ]) {
    assert.equal(isGatekeeperReasonQuestion(text), true, text);
  }
  for (const text of ["Herr Schneider ist nicht da.", "Kein Interesse.", "Einen Moment, ich verbinde."]) {
    assert.equal(isGatekeeperReasonQuestion(text), false, text);
  }
});

test("a reason question after the transfer request stays at reception without another identity check", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Schneider"),
    stage: "gatekeeper",
    gatekeeperRequestMade: true,
  }, "Worum geht es denn?");
  assert.equal(state.stage, "gatekeeper");
  assert.equal(state.gatekeeperRequestMade, true);
});

test("recognizes a reason question even before a transfer has been requested", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Neumann"),
    stage: "confirming_decision_maker",
  }, "Darf ich fragen, worum es geht?");
  assert.equal(state.stage, "gatekeeper");
});

test("does not mistake an explicit identity denial for the decision maker", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "confirming_decision_maker" as const,
  };
  for (const text of [
    "Nein, das bin ich nicht.",
    "Ich bin es leider nicht.",
    "Ja, ich bin nicht zuständig.",
  ]) {
    assert.equal(advanceContactRouting(state, text).stage, "gatekeeper", text);
  }
});

test("answers a reason question even when a short pause or a transfer offer is mentioned", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "gatekeeper" as const,
  };
  for (const text of [
    "Einen Moment, worum geht es?",
    "Ich kann Sie gerne verbinden. Worum geht es?",
  ]) {
    assert.equal(advanceContactRouting(state, text).stage, "gatekeeper", text);
  }
});

test("answers an interactive receptionist before waiting for an offered transfer", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "gatekeeper" as const,
  };
  for (const text of [
    "Ich kann Sie gerne verbinden. Wie lautet Ihr Name?",
    "Ich verbinde Sie gleich, wie kann ich Ihnen helfen?",
  ]) {
    assert.equal(advanceContactRouting(state, text).stage, "gatekeeper", text);
  }
});

test("recognizes offered and active transfers without confusing a refusal or a message", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "confirming_decision_maker" as const,
  };
  for (const text of [
    "Nein, aber ich kann Sie gerne weiterleiten.",
    "Soll ich Sie mit ihm verbinden?",
    "Ich stelle Sie zu Herrn Neumann durch.",
    "Ich stelle Ihnen Herrn Neumann durch.",
    "Ich leite Sie gleich weiter.",
    "Ich werde Sie gleich weiterleiten.",
    "Ich gebe Sie an Herrn Neumann weiter.",
  ]) {
    assert.equal(advanceContactRouting(state, text).stage, "waiting_for_transfer", text);
  }
  for (const text of [
    "Nein, ich kann Sie leider nicht weiterleiten.",
    "Ich verbinde Sie leider nicht.",
    "Ich leite Ihre Nachricht an Herrn Neumann weiter.",
  ]) {
    assert.equal(advanceContactRouting(state, text).stage, "gatekeeper", text);
  }
});

test("a yes to a transfer request starts waiting, not a second identity check", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "gatekeeper" as const,
    gatekeeperRequestMade: true,
  };
  assert.equal(advanceContactRouting(state, "Ja.").stage, "waiting_for_transfer");
  assert.equal(advanceContactRouting(state, "Ja, aber Herr Neumann ist nicht da.").stage, "gatekeeper");
});

test("a confirmed contact can also hand the call on to someone else", () => {
  const state = {
    ...createContactRoutingState("Herr Neumann"),
    stage: "decision_maker" as const,
  };
  assert.equal(advanceContactRouting(state, "Ich leite Sie gleich weiter.").stage, "waiting_for_transfer");
  assert.equal(advanceContactRouting(state, "Ich kann Sie gerne verbinden. Worum geht es?").stage, "decision_maker");
});

test("keeps the fachgespraech behind the gatekeeper boundary", () => {
  let state = createContactRoutingState("Herr Neumann");
  state = advanceContactRouting(state, "Guten Tag, Zentrale der Beispiel GmbH.");
  assert.equal(state.stage, "gatekeeper");

  state = advanceContactRouting(state, "Einen Moment bitte, ich verbinde Sie.");
  assert.equal(state.stage, "waiting_for_transfer");

  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("stays silent throughout queue announcements until a person answers", () => {
  let state = createContactRoutingState("Herr Neumann");
  state = advanceContactRouting(state, "Guten Tag, Zentrale der Beispiel GmbH.");
  assert.equal(state.stage, "gatekeeper");

  state = advanceContactRouting(state, "Einen Moment bitte, ich verbinde Sie.");
  assert.equal(state.stage, "waiting_for_transfer");

  state = advanceContactRouting(state, "Alle Mitarbeiter sind im Gespräch. Bitte warten Sie.");
  assert.equal(state.stage, "waiting_for_transfer");

  state = advanceContactRouting(state, "Neumann am Apparat, guten Tag.");
  assert.equal(state.stage, "decision_maker");
});

test("a caller identity question after a transfer is a new human contact", () => {
  const state = advanceContactRouting({
    ...createContactRoutingState("Herr Neumann"),
    stage: "waiting_for_transfer",
    gatekeeperRequestMade: true,
  }, "Wer ruft an?");
  assert.equal(state.stage, "confirming_decision_maker");
});

test("answers a digital receptionist that asks for the caller's name instead of waiting as in a queue", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Schwab"),
    "Herzlich willkommen und Glück auf! Mein Name ist Rosi Ruhrpott. Ich bin die digitale Assistentin von RAVES Immobilien und Schwab Hausverwaltung und helfe Ihnen dabei, Sie schnell mit dem richtigen Ansprechpartner zu verbinden. Wie lautet Ihr Name und wie kann ich Ihnen weiterhelfen?",
  );
  assert.equal(state.stage, "gatekeeper");
  assert.equal(advanceContactRouting(createContactRoutingState("Herr Schwab"), "Herzlich willkommen. Bitte warten Sie, wie kann ich Ihnen helfen?").stage, "waiting_for_transfer");
});

test("treats common short German phone greetings as a human contact", () => {
  for (const text of ["Ja, Müller?", "Müller, ja?", "Hallo, Schmidt.", "Ja bitte?"]) {
    assert.equal(advanceContactRouting(createContactRoutingState("Herr Neumann"), text).stage, "confirming_decision_maker", text);
  }
});

test("routes a receptionist who introduces herself by another name to the gatekeeper flow", () => {
  for (const [target, text] of [
    ["Michael Fürst", "Das ist oblic. Sie sprechen mit Frau Köhler. Schönen guten Morgen."],
    ["Benjamin Laube", "Hallo, Paula hier."],
    ["Herr Neumann", "Mein Name ist Sabine Kraus, was kann ich für Sie tun?"],
    ["Herr Neumann", "Guten Tag, Weber am Apparat."],
  ] as const) {
    assert.equal(advanceContactRouting(createContactRoutingState(target), text).stage, "gatekeeper", text);
  }
  assert.equal(advanceContactRouting(createContactRoutingState("Frau Köhler"), "Sie sprechen mit Frau Köhler, guten Tag.").stage, "decision_maker");
  assert.equal(advanceContactRouting(createContactRoutingState("Herr Neumann"), "Ich bin Makler.").stage, "confirming_decision_maker");
});

test("a garbled short first greeting counts as human contact instead of waiting silently", () => {
  for (const text of ["Keine reicht mehr.", "Kann sie so versorgen."]) {
    assert.equal(advanceContactRouting(createContactRoutingState("Ralf Lichtenberg"), text).stage, "confirming_decision_maker", text);
  }
  assert.equal(
    advanceContactRouting(createContactRoutingState("Herr Schmidt"), "Herzlich willkommen bei der Hausverwaltung Schmidt, Ihrem Immobilienpartner im Ruhrgebiet.").stage,
    "waiting_for_transfer",
  );
});

test("recognizes a self-identified decision maker without repeating the pitch", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Frau Wagner"),
    "Ja, das bin ich selbst.",
  );
  assert.equal(state.stage, "decision_maker");
});

test("a transfer announcement mentioning the target starts waiting rather than identifying the speaker", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Ich stelle Sie zu Herrn Neumann durch.",
  );
  assert.equal(state.stage, "waiting_for_transfer");
});

test("confirms an unclear name match once and accepts a clear yes", () => {
  const initial = advanceContactRouting(
    createContactRoutingState("Herr Biletzki"),
    "Guten Tag.",
  );
  assert.equal(initial.stage, "confirming_decision_maker");

  const confirmed = advanceContactRouting(initial, "Ja, genau, den haben Sie am Apparat.");
  assert.equal(confirmed.stage, "decision_maker");
});

test("routes a denied identity check to the gatekeeper without repeating the name check", () => {
  const initial = advanceContactRouting(
    createContactRoutingState("Herr Biletzki"),
    "Guten Tag.",
  );
  const denied = advanceContactRouting(initial, "Nein, ich bin aus dem Empfang.");

  assert.equal(denied.stage, "gatekeeper");
});

test("does not identify a target who is mentioned as unavailable", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Herr Neumann ist gerade nicht da.",
  );
  assert.equal(state.stage, "gatekeeper");
});

test("recognizes a direct name-based decision maker phrase", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Ja, hier ist Herr Neumann.",
  );
  assert.equal(state.stage, "decision_maker");

  const state2 = advanceContactRouting(
    createContactRoutingState("Frau Wagner"),
    "Ich bin Frau Wagner.",
  );
  assert.equal(state2.stage, "decision_maker");
});

test("treats a company greeting from another named person as a gatekeeper", () => {
  const state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Musterbau GmbH, mein Name ist Müller. Was kann ich für Sie tun?",
  );
  assert.equal(state.stage, "gatekeeper");
});

test("recognizes the target from the surname alone, even in a company greeting", () => {
  for (const text of [
    "Die Musterbau GmbH, mein Name ist Neumann, guten Tag.",
    "Musterbau GmbH, Neumann.",
    "Hier Neumann.",
    "Ja, Neumann.",
    "Ich bin Herr Neumann.",
  ]) {
    assert.equal(advanceContactRouting(createContactRoutingState("Martin Neumann"), text).stage, "decision_maker", text);
  }
  assert.notEqual(advanceContactRouting(createContactRoutingState("Martin Neumann"), "Herr Neumann?").stage, "decision_maker");
});

test("routes name-first greetings to the receptionist or target without repeating the identity check", () => {
  for (const text of ["Mussabaog, guten Tag.", "Müller, guten Tag.", "Paula hier."]) {
    assert.equal(advanceContactRouting(createContactRoutingState("Herr Neumann"), text).stage, "gatekeeper", text);
  }
  for (const [target, text] of [
    ["Herr Neumann", "Neumann, guten Tag."],
    ["Ralf Lichtenberg", "Ralf Lichtenberg, guten Tag."],
    ["Frau Köhler", "Sie sprechen mit Frau Köhler, guten Tag."],
  ] as const) {
    assert.equal(advanceContactRouting(createContactRoutingState(target), text).stage, "decision_maker", text);
  }
});

test("makes voicemail a terminal routing state", () => {
  let state = advanceContactRouting(
    createContactRoutingState("Herr Neumann"),
    "Bitte hinterlassen Sie eine Nachricht nach dem Signalton.",
  );
  assert.equal(state.stage, "voicemail");

  state = advanceContactRouting(state, "Neumann am Apparat.");
  assert.equal(state.stage, "voicemail");
});
test("names the concrete retry period from the reception in the farewell", () => {
  assert.equal(
    buildRetryFarewell("Herr Neumann hat diese Woche noch Urlaub, frühestens nächste Woche können Sie ihn erreichen."),
    "Vielen Dank. Dann versuche ich es nächste Woche erneut. Auf Wiederhören.",
  );
  assert.equal(buildRetryFarewell("Er ist morgen Nachmittag wieder da."), "Vielen Dank. Dann versuche ich es morgen Nachmittag erneut. Auf Wiederhören.");
  assert.equal(buildRetryFarewell("Am Donnerstag ist er wieder im Büro."), "Vielen Dank. Dann versuche ich es am Donnerstag erneut. Auf Wiederhören.");
  assert.equal(buildRetryFarewell("Ab 14 Uhr ist er wieder da."), "Vielen Dank. Dann versuche ich es ab 14 Uhr erneut. Auf Wiederhören.");
  assert.equal(buildRetryFarewell("Morgen gegen elf Uhr."), "Vielen Dank. Dann versuche ich es morgen gegen elf Uhr erneut. Auf Wiederhören.");
  assert.equal(buildRetryFarewell("Später, so gegen Mittag."), "Vielen Dank. Dann versuche ich es zu einem späteren Zeitpunkt erneut. Auf Wiederhören.");
  assert.equal(buildRetryFarewell("Das kann ich nicht sagen."), "Vielen Dank. Dann versuche ich es zu einem späteren Zeitpunkt erneut. Auf Wiederhören.");
  assert.equal(mentionsRetryTime("Herr Neumann ist heute nicht im Haus."), false);
  assert.equal(mentionsRetryTime("Guten Morgen, er ist nicht da."), false);
});

test("treats a different name before 'am Apparat' as reception and the target name as decision maker", () => {
  const reception = advanceContactRouting(createContactRoutingState("Herr Neumann"), "Mussabau GmbH Stapler am Apparat.");
  assert.equal(reception.stage, "gatekeeper");
  const target = advanceContactRouting(createContactRoutingState("Herr Neumann"), "Musterbau GmbH, Neumann am Apparat.");
  assert.equal(target.stage, "decision_maker");
});

test("reacts to a garbled greeting right after a transfer instead of waiting for 'Hallo'", () => {
  const waiting = { ...createContactRoutingState("Herr Neumann"), stage: "waiting_for_transfer" as const, gatekeeperRequestMade: true };
  const answered = advanceContactRouting(waiting, "Wirmausabogin bihannoi mana-maaparat?");
  assert.equal(answered.stage, "confirming_decision_maker");
  assert.equal(advanceContactRouting(waiting, "Herr Neumann, Telefon für Sie.").stage, "waiting_for_transfer");
});