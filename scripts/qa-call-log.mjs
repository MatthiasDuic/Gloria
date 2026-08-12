import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error("Usage: node scripts/qa-call-log.mjs <log-file> [--json]");
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) usage();

const logFile = args[0];
const asJson = args.includes("--json");
if (!fs.existsSync(logFile)) {
  console.error(`File not found: ${logFile}`);
  process.exit(2);
}

const raw = fs.readFileSync(logFile, "utf8");
const lines = raw.split(/\r?\n/).filter(Boolean);

const events = [];
for (const line of lines) {
  try {
    events.push(JSON.parse(line));
  } catch {
    // ignore non-json log lines
  }
}

const turns = [];
let current = null;
for (const ev of events) {
  if (ev.msg === "turn.user_said") {
    if (current) turns.push(current);
    current = {
      callSid: ev.callSid,
      user: ev.text || "",
      segments: [],
      pipeline: null,
    };
    continue;
  }
  if (!current) continue;
  if (ev.msg === "turn.gloria_segment" && typeof ev.text === "string") {
    current.segments.push(ev.text.trim());
  }
  if (ev.msg === "turn.pipeline") {
    current.pipeline = ev;
  }
}
if (current) turns.push(current);

const violations = [];
const stats = {
  turns: turns.length,
  repeatedSegments: 0,
  repeatedQuestions: 0,
  sourceClaims: 0,
  danglingContinuations: 0,
  earlyScheduling: 0,
  highSentenceCountTurns: 0,
  finalizePostFailed: events.filter((e) => e.msg === "finalize.post_failed").length,
};

const seenQuestionSet = new Set();
const userHistory = [];

function hasInsuranceSignal(text) {
  return /\b(privat(?:e[nrsm]?\s+krankenversicherung)?|pkv|gesetzlich(?:e[nrsm]?\s+krankenversicherung)?|gkv)\b/i.test(text);
}

function hasContributionSignal(text) {
  if (/\b(?:\d{2,5}(?:[.,:]\d{1,2})?)\b[^\n.?!]{0,16}\b(?:euro|€)\b/i.test(text)) return true;
  if (/\b(?:beitrag|kosten|monatlich)\b[^\n.?!]{0,30}\b(?:euro|€|tausend|hundert)\b/i.test(text)) return true;
  if (/\b(?:[a-zäöüß-]*tausend[a-zäöüß-]*|[a-zäöüß-]*hundert[a-zäöüß-]*)\b[^\n.?!]{0,24}\beuro\b/i.test(text)) return true;
  return false;
}

function hasProjectionSignal(text) {
  return /zehn\s+jahr|10\s+jahr|hochrechn|projektion|beitragsprognose|vier\s+prozent\s+pro\s+jahr|4\s*%\s+pro\s+jahr/i.test(text);
}

for (let i = 0; i < turns.length; i += 1) {
  const turn = turns[i];
  userHistory.push(turn.user || "");

  const normalizedSegments = turn.segments
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean);

  for (let j = 1; j < normalizedSegments.length; j += 1) {
    if (normalizedSegments[j] === normalizedSegments[j - 1]) {
      stats.repeatedSegments += 1;
      violations.push({ type: "repeated_segment", turn: i + 1, text: turn.segments[j] });
    }
  }

  for (const segment of turn.segments) {
    if (/\blaut\s+pkv-?verband\b/i.test(segment)) {
      stats.sourceClaims += 1;
      violations.push({ type: "source_claim", turn: i + 1, text: segment });
    }

    if (/^(?:um|und|oder|damit|wobei|sowie|denn|also)\b/i.test(segment.trim()) && segment.trim().length < 95) {
      stats.danglingContinuations += 1;
      violations.push({ type: "dangling_continuation", turn: i + 1, text: segment });
    }

    if (/\?/.test(segment)) {
      const qKey = segment.replace(/\s+/g, " ").trim().toLowerCase();
      if (seenQuestionSet.has(qKey)) {
        stats.repeatedQuestions += 1;
        violations.push({ type: "repeated_question", turn: i + 1, text: segment });
      }
      seenQuestionSet.add(qKey);
    }

    const scheduleAsk = /\b(termin|vormittag|nachmittag|welcher\s+tag|wann\s+passt|w[üu]rde\s+.*\stermin|interesse\s+an\s+einem\s+termin)\b/i.test(segment);
    if (scheduleAsk) {
      const combinedUser = userHistory.join(" \n ");
      const combinedAssistant = turns.slice(0, i + 1).flatMap((t) => t.segments).join(" \n ");
      const ready = hasInsuranceSignal(combinedUser) && hasContributionSignal(combinedUser) && hasProjectionSignal(combinedAssistant);
      if (!ready) {
        stats.earlyScheduling += 1;
        violations.push({ type: "early_scheduling", turn: i + 1, text: segment });
      }
    }
  }

  const sentenceCount = Number(turn?.pipeline?.sentenceCount || 0);
  if (sentenceCount >= 4) {
    stats.highSentenceCountTurns += 1;
    violations.push({
      type: "high_sentence_count",
      turn: i + 1,
      sentenceCount,
      user: turn.user,
    });
  }
}

const report = {
  file: path.resolve(logFile),
  stats,
  violations,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log("Call QA Report");
console.log(`File: ${report.file}`);
console.log(`Turns: ${stats.turns}`);
console.log(`Violations: ${violations.length}`);
console.log(`- repeated segments: ${stats.repeatedSegments}`);
console.log(`- repeated questions: ${stats.repeatedQuestions}`);
console.log(`- source claims: ${stats.sourceClaims}`);
console.log(`- dangling continuations: ${stats.danglingContinuations}`);
console.log(`- early scheduling: ${stats.earlyScheduling}`);
console.log(`- high sentence-count turns (>=4): ${stats.highSentenceCountTurns}`);
console.log(`- finalize post failed events: ${stats.finalizePostFailed}`);

if (violations.length > 0) {
  console.log("\nTop findings:");
  for (const finding of violations.slice(0, 20)) {
    if (finding.text) {
      console.log(`- [turn ${finding.turn}] ${finding.type}: ${finding.text}`);
    } else {
      console.log(`- [turn ${finding.turn}] ${finding.type}`);
    }
  }
}
