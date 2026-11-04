import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationEvent, instructionForConversationEvent } from "./conversation-event-controller.js";

test("distinguishes a factual no from a clear conversation rejection", () => {
  assert.equal(classifyConversationEvent("Nein.").type, "answer");
  assert.equal(classifyConversationEvent("Nein, ich bin gesetzlich versichert.").type, "answer");
  assert.equal(classifyConversationEvent("Ich denke nicht.").type, "answer");
  assert.equal(classifyConversationEvent("Ich denke nicht, dass das passt.").type, "answer");
  assert.equal(classifyConversationEvent("Ich habe kein Interesse, rufen Sie bitte nicht mehr an.").type, "clear_rejection");
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
    assert.equal(classifyConversationEvent(text).type, "clear_rejection", text);
  }
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
  assert.match(email, /E-Mail-Adresse/);
  assert.match(skepticism, /nachvollziehbaren Annahmen/);
});

test("keeps unclear fragments from changing the flow", () => {
  const event = classifyConversationEvent("Mhm.");
  assert.equal(event.type, "unclear");
  assert.match(instructionForConversationEvent(event), /keine Zustimmung/);
  assert.equal(classifyConversationEvent("Das.").type, "unclear");
  assert.equal(classifyConversationEvent("Das...").type, "unclear");
});