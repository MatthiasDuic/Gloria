import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCampaignSchedule, isWithinCampaignHours } from "./campaign-schedule";

test("campaigns run continuously from 09:00 until 17:30 Berlin time on weekdays", () => {
  const previousSlots = process.env.CAMPAIGN_SLOTS;
  const previousTimezone = process.env.CAMPAIGN_TIMEZONE;
  delete process.env.CAMPAIGN_SLOTS;
  delete process.env.CAMPAIGN_TIMEZONE;
  try {
    assert.deepEqual(describeCampaignSchedule(), { timezone: "Europe/Berlin", windows: ["09:00-17:30"] });
    for (const [timestamp, expected] of [
      ["2026-11-03T07:59:59Z", false],
      ["2026-11-03T08:00:00Z", true],
      ["2026-11-03T11:30:00Z", true],
      ["2026-11-03T16:29:59Z", true],
      ["2026-11-03T16:30:00Z", false],
      ["2026-11-03T20:00:00Z", false],
      ["2026-11-04T07:59:59Z", false],
      ["2026-11-04T08:00:00Z", true],
      ["2026-07-07T06:59:59Z", false],
      ["2026-07-07T07:00:00Z", true],
      ["2026-07-07T15:29:59Z", true],
      ["2026-07-07T15:30:00Z", false],
      ["2026-11-07T10:00:00Z", false],
      ["2026-11-08T10:00:00Z", false],
      ["2026-11-09T08:00:00Z", true],
    ] as const) {
      assert.equal(isWithinCampaignHours(new Date(timestamp)), expected, timestamp);
    }
  } finally {
    if (previousSlots === undefined) delete process.env.CAMPAIGN_SLOTS;
    else process.env.CAMPAIGN_SLOTS = previousSlots;
    if (previousTimezone === undefined) delete process.env.CAMPAIGN_TIMEZONE;
    else process.env.CAMPAIGN_TIMEZONE = previousTimezone;
  }
});