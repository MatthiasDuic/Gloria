import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationEvent, instructionForConversationEvent, isConversationEndingText } from "./conversation-event-controller.js";

test("distinguishes a factual no from a clear conversation rejection", () => {
  assert.equal(classifyConversationEvent("Nein.").type, "answer");
  assert.equal(classifyConversationEvent("Nein, ich bin gesetzlich versichert.").type, "answer");
  assert.equal(classifyConversationEvent("Ich denke nicht.").type, "answer");
  assert.equal(classifyConversationEvent("Ich denke nicht, dass das passt.").type, "answer");
  assert.equal(classifyConversationEvent("Ich habe kein Interesse, rufen Sie bitte nicht mehr an.").type, "opt_out");
  assert.equal(classifyConversationEvent("Nein danke, kein Interesse.").type, "clear_rejection");
  assert.equal(classifyConversationEvent("Danke, auf Wiederhören.").type, "clear_rejection");
  assert.equal(classifyConversationEvent("Nein, wir können das Gespräch beenden.").type, "clear_rejection");
});

test("prioritizes a customer question over continuing the scripted flow", () => {
  const event = classifyConversationEvent("Warum gehen Sie von vier Prozent aus?");
  assert.equal(event.type, "customer_question");
  const instruction = instructionForConversationEvent(event, "Frage nach dem Monatsbeitrag.");
  assert.match(instruction, /Beantworte zuerst/);
  assert.match(instruction, /nächsten fachlichen Schritt/);
});

test("never treats ordinary call questions or callback requests as a rejection", () => {
  for (const text of ["Warum rufen Sie an?", "Können Sie mich morgen anrufen?", "Rufen Sie bitte in zehn Minuten wieder an."]) {
    assert.notEqual(classifyConversationEvent(text).type, "clear_rejection", text);
  }
  for (const text of ["Rufen Sie mich bitte nicht mehr an.", "Bitte nicht mehr anrufen.", "Ich möchte keine weiteren Anrufe."]) {
    assert.equal(classifyConversationEvent(text).type, "opt_out", text);
  }
});

test("treats do-not-call and deletion requests as opt-out, never as an objection to argue with", () => {
  for (const text of [
    "Löschen Sie meine Daten.",
    "Ich möchte, dass Sie meine Daten löschen.",
    "Nehmen Sie mich bitte aus Ihrer Liste.",
    "Streichen Sie uns aus Ihrer Datenbank.",
    "Ich widerspreche der Nutzung meiner Daten.",
    "Hören Sie auf, mich anzurufen.",
  ]) {
    const event = classifyConversationEvent(text);
    assert.equal(event.type, "opt_out", text);
  }
  const deletion = classifyConversationEvent("Löschen Sie meine Daten.");
  assert.equal(deletion.type === "opt_out" && deletion.deletion, true);
  const noCalls = classifyConversationEvent("Bitte nicht mehr anrufen.");
  assert.equal(noCalls.type === "opt_out" && noCalls.deletion, false);
  assert.match(instructionForConversationEvent(deletion), /end_call/);
  for (const text of ["Können Sie mir das löschen, was ich eben gesagt habe? Nein, Spaß.", "Rufen Sie bitte morgen wieder an."]) {
    assert.notEqual(classifyConversationEvent(text).type, "opt_out", text);
  }
});

test("ends politely on a firm refusal of telephone business", () => {
  for (const text of ["Wir kaufen nichts am Telefon.", "Wir machen grundsätzlich keine Geschäfte am Telefon."]) {
    assert.equal(classifyConversationEvent(text).type, "clear_rejection", text);
    assert.equal(isConversationEndingText(text), true, text);
  }
});

test("recognises data-source, AI identity and small-talk questions", () => {
  for (const text of ["Woher haben Sie überhaupt meine Nummer?", "Wie kommen Sie denn auf mich?", "Wer hat Ihnen meine Nummer gegeben?"]) {
    assert.equal(classifyConversationEvent(text).type, "data_source_question", text);
  }
  for (const text of ["Moment mal, sind Sie eine KI?", "Bin ich hier mit einem Roboter verbunden? Sind Sie ein Roboter?", "Rede ich gerade mit einem Menschen?"]) {
    assert.equal(classifyConversationEvent(text).type, "ai_identity_question", text);
  }
  for (const text of ["Wie ist denn das Wetter bei Ihnen?", "Wie geht es Ihnen denn?", "Haben Sie gestern Fußball geschaut?"]) {
    const event = classifyConversationEvent(text);
    assert.equal(event.type, "small_talk", text);
    assert.match(instructionForConversationEvent(event, "Frage nach dem Monatsbeitrag."), /zurück zum Anliegen|Brücke/);
  }
});

test("gives one respectful clarification on a first 'kein Bedarf' and accepts a repeated one", () => {
  const first = classifyConversationEvent("Kein Bedarf.");
  assert.deepEqual(first, { type: "objection", text: "Kein Bedarf.", kind: "no_need" });
  const repeated = classifyConversationEvent("Nein, wirklich kein Bedarf.", { previousUserTexts: ["Kein Bedarf."] });
  assert.equal(repeated.type, "clear_rejection");
  for (const text of ["Das macht alles mein Steuerberater.", "Wir haben schon einen Makler.", "Ich bin selbst Makler."]) {
    const event = classifyConversationEvent(text);
    assert.equal(event.type === "objection" && event.kind, "existing_advisor", text);
  }
  assert.match(instructionForConversationEvent(classifyConversationEvent("Das macht mein Steuerberater.")), /Steuerberater/);
});

test("treats a recommendation request as a customer question, not as an existing-advisor objection", () => {
  for (const text of [
    "Sagen Sie mal, kennen Sie eigentlich einen guten Steuerberater hier in der Gegend?",
    "Können Sie mir einen Makler empfehlen?",
  ]) {
    assert.equal(classifyConversationEvent(text).type, "customer_question", text);
  }
  const ownAdvisor = classifyConversationEvent("Das macht bei uns alles der Steuerberater.");
  assert.equal(ownAdvisor.type === "objection" && ownAdvisor.kind, "existing_advisor");
});

test("answers cost questions without inventing a free appointment", () => {
  for (const text of ["Und was kostet mich das?", "Was kostet denn so ein Termin?", "Ist die Beratung kostenlos?", "Muss ich dafür was bezahlen?"]) {
    const event = classifyConversationEvent(text);
    assert.equal(event.type === "objection" && event.kind, "price", text);
    const instruction = instructionForConversationEvent(event);
    assert.match(instruction, /kostenfrei/);
    assert.match(instruction, /nur als kostenfrei, wenn der Auftrag/);
    assert.match(instruction, /Erfinde keine Honorare/);
  }
  assert.equal(classifyConversationEvent("Was kostet eine private Krankenversicherung im Alter?").type, "customer_question");
});

test("handles driving, consulting a partner and statutory-insurance objections without a sales push", () => {
  for (const [text, kind] of [
    ["Ich bin gerade im Auto.", "no_time"],
    ["Ich fahre gerade Auto.", "no_time"],
    ["Das muss ich mit meiner Frau besprechen.", "consult_partner"],
    ["Ich bin gesetzlich versichert, das betrifft mich nicht.", "statutory_insurance"],
  ] as const) {
    const event = classifyConversationEvent(text);
    assert.equal(event.type === "objection" && event.kind, kind);
    assert.ok(instructionForConversationEvent(event).length > 100);
  }
  assert.equal(classifyConversationEvent("Ich bin gesetzlich versichert.").type, "answer");
});

test("classifies common objections by intent", () => {
  assert.deepEqual(classifyConversationEvent("Ich habe gerade wirklich keine Zeit."), {
    type: "objection",
    text: "Ich habe gerade wirklich keine Zeit.",
    kind: "no_time",
  });
  assert.equal(classifyConversationEvent("Schicken Sie mir das lieber per Mail.").type, "objection");
  assert.equal(classifyConversationEvent("Mein Makler kümmert sich bereits darum.").type, "objection");
});

test("provides a short, concrete reply guide for every objection type", () => {
  const noTime = instructionForConversationEvent(classifyConversationEvent("Ich habe gerade keine Zeit."));
  const advisor = instructionForConversationEvent(classifyConversationEvent("Mein Makler kümmert sich darum."));
  const email = instructionForConversationEvent(classifyConversationEvent("Schicken Sie mir etwas per Mail."));
  const skepticism = instructionForConversationEvent(classifyConversationEvent("Das klingt unrealistisch."));

  assert.match(noTime, /Rückrufzeitpunkt/);
  assert.match(advisor, /Zweitblick/);
  assert.match(email, /genau eine Frage/);
  assert.match(email, /keinen Unterlagenversand/);
  assert.match(skepticism, /nachvollziehbaren Annahmen/);
});

test("keeps unclear fragments from changing the flow", () => {
  const event = classifyConversationEvent("Mhm.");
  assert.equal(event.type, "unclear");
  assert.match(instructionForConversationEvent(event), /keine Zustimmung/);
  assert.equal(classifyConversationEvent("Das.").type, "unclear");
  assert.equal(classifyConversationEvent("Das...").type, "unclear");
});