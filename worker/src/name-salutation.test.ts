import assert from "node:assert/strict";
import test from "node:test";
import { addressPersonDative, detectGenderFromName } from "./name-salutation.js";

test("adds Herrn or Frau based on the first name", () => {
  for (const name of ["Martin Müller", "Alexander Schmidt", "Marc Weber", "Michael Fürst", "Hans-Peter Klein"]) {
    assert.equal(addressPersonDative(name), `Herrn ${name}`, name);
  }
  for (const name of ["Petra Schulz", "Sabine Köhler", "Anna-Lena Wolf"]) {
    assert.equal(addressPersonDative(name), `Frau ${name}`, name);
  }
  assert.equal(addressPersonDative("Dr. Martin Müller"), "Herrn Dr. Martin Müller");
});

test("recognizes common European first names, also without diacritics", () => {
  for (const name of ["Giuseppe Rossi", "José García", "Jose Garcia", "François Dubois", "Piotr Nowak", "Łukasz Kowalski",
    "Lukasz Kowalski", "Dražen Horvat", "Ömer Yıldız", "Omer Yildiz", "Georgios Papadopoulos", "Jean-Luc Martin", "Luca Bianchi"]) {
    assert.equal(addressPersonDative(name), `Herrn ${name}`, name);
  }
  for (const name of ["Giulia Rossi", "Lucía Fernández", "Małgorzata Nowak", "Ayşe Demir", "Ayse Demir", "Ivana Horvat",
    "Zsuzsanna Nagy", "Siobhan Murphy"]) {
    assert.equal(addressPersonDative(name), `Frau ${name}`, name);
  }
});

test("leaves names without salutation whose gender differs between countries", () => {
  for (const name of ["Andrea Meier", "Simone Bianchi", "Nicola Russo", "Gabriele Ferrari", "Jasmin Hodžić", "Deniz Yılmaz"]) {
    assert.equal(addressPersonDative(name), name, name);
  }
});

test("keeps an existing salutation and leaves unknown or unisex names untouched", () => {
  assert.equal(addressPersonDative("Herr Neumann"), "Herrn Neumann");
  assert.equal(addressPersonDative("Frau Meier"), "Frau Meier");
  assert.equal(addressPersonDative("frau Petra Meier"), "Frau Petra Meier");
  for (const name of ["Alex Beispiel", "Kim Wagner", "Robin Hoffmann", "Neumann", "Xaver-Q Unbekannt"]) {
    assert.equal(addressPersonDative(name), name, name);
  }
  assert.equal(addressPersonDative("Alex Beispiel", "male"), "Herrn Alex Beispiel");
  assert.equal(detectGenderFromName("Martin"), undefined, "a single word may be a surname");
});
