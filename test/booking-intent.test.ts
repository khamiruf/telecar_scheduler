import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCarRequests } from "@/worker/telegram/booking-intent";
import { action, fakeAI, makeEnv, sg } from "./helpers";

// Tuesday 13 Oct 2026, 10:00 in Singapore. Day index 0 = Tue 13, 1 = Wed 14, ...
const NOW = sg("2026-10-13T10:00");

function envWith(...replies: unknown[]) {
  const ai = fakeAI(...replies);
  return { env: makeEnv({} as D1Database, ai), ai };
}

describe("parseCarRequests", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("returns both requests from 'Cancel my booking for Wednesday. Book for tonight instead'", async () => {
    const { env } = envWith({
      actions: [
        action("cancel", { startDay: 1, endDay: 1, part: "whole" }),
        action("book", { startDay: 0, endDay: 0, part: "evening" }),
      ],
    });
    const requests = await parseCarRequests(env, "Cancel my booking for Wednesday. Book for tonight instead");
    expect(requests).toEqual([
      { type: "cancel", when: { startsAt: sg("2026-10-14T00:00"), endsAt: sg("2026-10-14T23:59:59") } },
      { type: "book", range: { startsAt: sg("2026-10-13T18:00"), endsAt: sg("2026-10-13T23:00") } },
    ]);
  });

  it("reads a reply that arrives as a string wrapped in prose / code fences", async () => {
    const reply =
      "Here you go:\n```json\n" +
      JSON.stringify({ actions: [action("cancel", { startDay: 1, endDay: 1, part: "whole" }), action("book", { startDay: 0, part: "evening" })] }) +
      "\n```";
    const { env } = envWith(reply);
    const requests = await parseCarRequests(env, "cancel wed and book tonight");
    expect(requests?.map((r) => r.type)).toEqual(["cancel", "book"]);
  });

  it("treats a cancel with no day as 'soonest'", async () => {
    const { env } = envWith({ actions: [action("cancel")] });
    expect(await parseCarRequests(env, "cancel my booking")).toEqual([{ type: "cancel", when: "soonest" }]);
  });

  it("marks a cancel with an out-of-range day as 'unclear'", async () => {
    const { env } = envWith({ actions: [action("cancel", { startDay: 99 })] });
    expect(await parseCarRequests(env, "cancel the one in march")).toEqual([{ type: "cancel", when: "unclear" }]);
  });

  it("resolves clock hours, including half hours", async () => {
    const { env } = envWith({ actions: [action("book", { startDay: 4, endDay: 4, startHour: 14.5, endHour: 18 })] });
    expect(await parseCarRequests(env, "book saturday 2:30pm to 6pm")).toEqual([
      { type: "book", range: { startsAt: sg("2026-10-17T14:30"), endsAt: sg("2026-10-17T18:00") } },
    ]);
  });

  it.each([
    ["'tonight 7pm' runs to the end of the evening", { startDay: 0, part: "evening", startHour: 19 }, "2026-10-13T19:00", "2026-10-13T23:00"],
    ["'tomorrow 2pm' runs to the end of the afternoon", { startDay: 1, startHour: 14 }, "2026-10-14T14:00", "2026-10-14T18:00"],
    ["'saturday 9:30am' runs to noon", { startDay: 4, startHour: 9.5 }, "2026-10-17T09:30", "2026-10-17T12:00"],
    ["'tonight 11:30pm' runs to the end of the day", { startDay: 0, startHour: 23.5 }, "2026-10-13T23:30", "2026-10-13T23:59:59"],
  ])("a single start time: %s", async (_label, fields, from, to) => {
    const { env } = envWith({ actions: [action("book", fields)] });
    expect(await parseCarRequests(env, "book")).toEqual([{ type: "book", range: { startsAt: sg(from), endsAt: sg(to) } }]);
  });

  it("tells the model a clock time beats a part of day", async () => {
    const { env, ai } = envWith({ actions: [action("book", { startDay: 0, startHour: 19 })] });
    await parseCarRequests(env, "Book for tonight 7pm");
    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    expect(systemPrompt).toContain('"tonight 7pm"');
    expect(systemPrompt).toContain("A clock time always wins");
  });

  it("drops the range of a booking that has already ended", async () => {
    const { env } = envWith({ actions: [action("book", { startDay: 0, endDay: 0, startHour: 6, endHour: 8 })] });
    expect(await parseCarRequests(env, "book today 6am to 8am")).toEqual([{ type: "book", range: null }]);
  });

  it.each([
    ["an explicit error", { error: "unclear" }],
    ["an empty action list", { actions: [] }],
    ["non-JSON text", "sorry, I can't help with that"],
    ["a thrown AI error", new Error("AI down")],
  ])("returns null on %s", async (_label, reply) => {
    const { env } = envWith(reply);
    expect(await parseCarRequests(env, "book something")).toBeNull();
  });

  it("dates the calendar in Singapore time, not UTC", async () => {
    // 01:00 Wed in Singapore is still Tuesday in UTC.
    vi.setSystemTime(sg("2026-10-14T01:00") * 1000);
    const { env, ai } = envWith({ actions: [action("book", { startDay: 0, part: "evening" })] });
    const requests = await parseCarRequests(env, "book tonight");

    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    expect(systemPrompt).toContain("Today is Wed Oct 14");
    expect(requests).toEqual([
      { type: "book", range: { startsAt: sg("2026-10-14T18:00"), endsAt: sg("2026-10-14T23:00") } },
    ]);
  });
});
