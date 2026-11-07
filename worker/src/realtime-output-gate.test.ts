import assert from "node:assert/strict";
import test from "node:test";
import { RealtimeOutputGate, stripMetaCommentary } from "./realtime-output-gate.js";

function speak(gate: RealtimeOutputGate, steps: Array<{ item?: { id: string; type: string; phase?: string; name?: string }; delta?: [string, string] }>): string {
  let spoken = "";
  for (const step of steps) {
    if (step.item) spoken += gate.observeItem(step.item);
    if (step.delta) spoken += gate.acceptText(step.delta[0], step.delta[1]);
  }
  return spoken + gate.finish();
}

test("drops a commentary preamble before the final answer", () => {
  const gate = new RealtimeOutputGate();
  const spoken = speak(gate, [
    { item: { id: "c1", type: "message", phase: "commentary" } },
    { delta: ["c1", "Prima, dann finden wir als Nächstes eine passende Zeit—"] },
    { delta: ["c1", "ich frage zuerst kurz nach Ihrer Tagespräferenz."] },
    { item: { id: "f1", type: "message", phase: "final_answer" } },
    { delta: ["f1", "Passt Ihnen eher vormittags oder nachmittags?"] },
  ]);
  assert.equal(spoken, "Passt Ihnen eher vormittags oder nachmittags?");
  assert.deepEqual(gate.takeSuppressed(), ["Prima, dann finden wir als Nächstes eine passende Zeit—ich frage zuerst kurz nach Ihrer Tagespräferenz."]);
});

test("drops a commentary preamble before an appointment booking", () => {
  const gate = new RealtimeOutputGate();
  const spoken = speak(gate, [
    { item: { id: "c1", type: "message", phase: "commentary" } },
    { delta: ["c1", "Alles klar, ich prüfe kurz die Terminbestätigung und schließe das für Sie sauber ab."] },
    { item: { id: "t1", type: "function_call", name: "confirm_appointment" } },
  ]);
  assert.equal(spoken, "");
  assert.equal(gate.takeSuppressed().length, 1);
});

test("speaks commentary that announces a hangup or a human transfer", () => {
  for (const name of ["end_call", "transfer_to_human"]) {
    const gate = new RealtimeOutputGate();
    let spoken = gate.observeItem({ id: "c1", type: "message", phase: "commentary" });
    spoken += gate.acceptText("c1", "Vielen Dank für Ihre Zeit. Auf Wiederhören.");
    assert.equal(spoken, "", "commentary stays held until the next item is known");
    spoken += gate.observeItem({ id: "t1", type: "function_call", name });
    assert.equal(spoken, "Vielen Dank für Ihre Zeit. Auf Wiederhören.");
    assert.deepEqual(gate.takeSuppressed(), []);
  }
});

test("speaks commentary when nothing else follows in the response", () => {
  const gate = new RealtimeOutputGate();
  const spoken = speak(gate, [
    { item: { id: "c1", type: "message", phase: "commentary" } },
    { delta: ["c1", "Gerne, Montag passt."] },
  ]);
  assert.equal(spoken, "Gerne, Montag passt.");
});

test("streams final answers and items without phase immediately", () => {
  const gate = new RealtimeOutputGate();
  assert.equal(gate.observeItem({ id: "f1", type: "message", phase: "final_answer" }), "");
  assert.equal(gate.acceptText("f1", "Guten "), "Guten ");
  assert.equal(gate.acceptText("f1", "Tag."), "Tag.");
  gate.reset();
  assert.equal(gate.observeItem({ id: "m1", type: "message" }), "");
  assert.equal(gate.acceptText("m1", "Hallo."), "Hallo.");
  assert.equal(gate.acceptText(undefined, " Wie geht es?"), " Wie geht es?");
});

test("separates consecutive spoken items with a space", () => {
  const gate = new RealtimeOutputGate();
  const spoken = speak(gate, [
    { item: { id: "f1", type: "message", phase: "final_answer" } },
    { delta: ["f1", "Freut mich."] },
    { item: { id: "f2", type: "message", phase: "final_answer" } },
    { delta: ["f2", "Passt Ihnen eher vormittags?"] },
  ]);
  assert.equal(spoken, "Freut mich. Passt Ihnen eher vormittags?");
});

test("waits for the tool name when the function call item arrives without it", () => {
  const gate = new RealtimeOutputGate();
  gate.observeItem({ id: "c1", type: "message", phase: "commentary" });
  gate.acceptText("c1", "Auf Wiederhören.");
  assert.equal(gate.observeItem({ id: "t1", type: "function_call" }), "");
  assert.equal(gate.observeItem({ type: "function_call", name: "end_call" }), "Auf Wiederhören.");
});

test("reset forgets held commentary from a previous response", () => {
  const gate = new RealtimeOutputGate();
  gate.observeItem({ id: "c1", type: "message", phase: "commentary" });
  gate.acceptText("c1", "Ich prüfe kurz.");
  gate.reset();
  assert.equal(gate.finish(), "");
  assert.deepEqual(gate.takeSuppressed(), []);
});

test("never speaks internal meta commentary about the customer or the hang-up", () => {
  assert.equal(stripMetaCommentary("Der Kunde möchte keine Anrufe mehr. Selbstverständlich, entschuldigen Sie die Störung. Auf Wiederhören."),
    "Selbstverständlich, entschuldigen Sie die Störung. Auf Wiederhören.");
  assert.equal(stripMetaCommentary("Ich beende jetzt das Gespräch. Auf Wiederhören."), "Auf Wiederhören.");
  assert.equal(stripMetaCommentary("Ich rufe end_call auf."), "");
  assert.equal(stripMetaCommentary("Vielen Dank für das Gespräch. Auf Wiederhören."), "Vielen Dank für das Gespräch. Auf Wiederhören.");

  const gate = new RealtimeOutputGate();
  const spoken = speak(gate, [
    { item: { id: "c1", type: "message", phase: "commentary" } },
    { delta: ["c1", "Die Person lehnt ab. Alles Gute, auf Wiederhören."] },
    { item: { id: "t1", type: "function_call", name: "end_call" } },
  ]);
  assert.equal(spoken, "Alles Gute, auf Wiederhören.");
  assert.deepEqual(gate.takeSuppressed(), ["Die Person lehnt ab. Alles Gute, auf Wiederhören."]);
});

test("drops a farewell announcement when the hang-up is not allowed and adds a farewell to a silent hang-up", () => {
  const blocked = new RealtimeOutputGate({ canAnnounce: () => false });
  const spokenWhenBlocked = speak(blocked, [
    { item: { id: "c1", type: "message", phase: "commentary" } },
    { delta: ["c1", "Dann beende ich das Gespräch. Auf Wiederhören."] },
    { item: { id: "t1", type: "function_call", name: "end_call" } },
  ]);
  assert.equal(spokenWhenBlocked, "");

  const silent = new RealtimeOutputGate({ hangupFallbackText: "Vielen Dank für Ihre Zeit. Auf Wiederhören." });
  assert.equal(silent.observeItem({ id: "t1", type: "function_call", name: "end_call" }), "Vielen Dank für Ihre Zeit. Auf Wiederhören.");
});
