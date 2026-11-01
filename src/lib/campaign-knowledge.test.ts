import assert from "node:assert/strict";
import test from "node:test";
import {
  CampaignKnowledgeError,
  extractSameOriginLinks,
  extractReadableText,
  isPublicIpAddress,
  normalizeKnowledgeSources,
} from "./campaign-knowledge";

test("normalizes public HTTPS campaign sources and removes fragments", () => {
  assert.deepEqual(
    normalizeKnowledgeSources([" https://example.org/faq#questions ", "https://example.org/faq"]),
    ["https://example.org/faq"],
  );
});

test("rejects insecure, local, and private campaign sources", () => {
  for (const source of [
    "http://example.org",
    "https://localhost/health",
    "https://127.0.0.1/admin",
    "https://192.168.1.1/",
    "https://user:pass@example.org/",
  ]) {
    assert.throws(() => normalizeKnowledgeSources([source]), CampaignKnowledgeError);
  }
});

test("limits the number of sources", () => {
  assert.throws(
    () => normalizeKnowledgeSources(Array.from({ length: 7 }, (_, index) => `https://example${index}.org`)),
    /höchstens 6 Wissensquellen/,
  );
});

test("classifies private and public addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("192.0.2.10"), false);
  assert.equal(isPublicIpAddress("10.2.3.4"), false);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("2001:4860:4860::8888"), true);
});

test("extracts readable text while dropping active and hidden HTML", () => {
  const text = extractReadableText(
    "<h1>Wissen&nbsp;&amp; Fakten</h1><script>doNotUse()</script><p>Nur <strong>Text</strong>.</p>",
  );
  assert.equal(text, "Wissen & Fakten\nNur Text.");
  assert.equal(text.includes("doNotUse"), false);
});

test("collects internal HTTPS links and ignores external and tracking links", () => {
  assert.deepEqual(
    extractSameOriginLinks(
      '<a href="/leistungen">Leistungen</a><a href="https://other.example/page">Extern</a><a href="/wissen?utm_source=newsletter#top">Wissen</a>',
      "https://example.org/",
    ),
    ["https://example.org/leistungen", "https://example.org/wissen"],
  );
});
