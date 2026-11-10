import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCarRequests } from "@/worker/telegram/booking-intent";
import { action, day, fakeAI, makeEnv, sg } from "./helpers";

// Tuesday 13 Oct 2026, 10:00 in Singapore. day(0) = "2026-10-13", day(1) = "2026-10-14", ...
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
        action("cancel", { startDate: day(1), endDate: day(1), part: "whole" }),
        action("book", { startDate: day(0), endDate: day(0), part: "evening" }),
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
      JSON.stringify({ actions: [action("cancel", { startDate: day(1), endDate: day(1), part: "whole" }), action("book", { startDate: day(0), part: "evening" })] }) +
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
    const { env } = envWith({ actions: [action("cancel", { startDate: "2026-13-45" })] });
    expect(await parseCarRequests(env, "cancel the one in march")).toEqual([{ type: "cancel", when: "unclear" }]);
  });

  it("resolves clock hours, including half hours", async () => {
    const { env } = envWith({ actions: [action("book", { startDate: day(4), endDate: day(4), startHour: 14.5, endHour: 18 })] });
    expect(await parseCarRequests(env, "book saturday 2:30pm to 6pm")).toEqual([
      { type: "book", range: { startsAt: sg("2026-10-17T14:30"), endsAt: sg("2026-10-17T18:00") } },
    ]);
  });

  it.each([
    ["'tonight 7pm' runs to the end of the evening", { startDate: day(0), part: "evening", startHour: 19 }, "2026-10-13T19:00", "2026-10-13T23:00"],
    ["'tomorrow 2pm' runs to the end of the afternoon", { startDate: day(1), startHour: 14 }, "2026-10-14T14:00", "2026-10-14T18:00"],
    ["'saturday 9:30am' runs to noon", { startDate: day(4), startHour: 9.5 }, "2026-10-17T09:30", "2026-10-17T12:00"],
    ["'tonight 11:30pm' runs to the end of the day", { startDate: day(0), startHour: 23.5 }, "2026-10-13T23:30", "2026-10-13T23:59:59"],
  ])("a single start time: %s", async (_label, fields, from, to) => {
    const { env } = envWith({ actions: [action("book", fields)] });
    expect(await parseCarRequests(env, "book")).toEqual([{ type: "book", range: { startsAt: sg(from), endsAt: sg(to) } }]);
  });

  it("tells the model a clock time beats a part of day", async () => {
    const { env, ai } = envWith({ actions: [action("book", { startDate: day(0), startHour: 19 })] });
    await parseCarRequests(env, "Book for tonight 7pm");
    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    expect(systemPrompt).toContain('"tonight 7pm"');
    expect(systemPrompt).toContain("A clock time always wins");
  });

  it("reads list and calendar requests", async () => {
    const { env } = envWith({
      actions: [action("list", { whose: "mine" }), action("list", { whose: "everyone" }), action("list"), action("calendar")],
    });
    expect(await parseCarRequests(env, "my bookings, everyone's, and the calendar")).toEqual([
      { type: "list", whose: "mine" },
      { type: "list", whose: "everyone" },
      { type: "list", whose: "mine" }, // whose missing → the sender's own
      { type: "calendar" },
    ]);
  });

  it("reads availability checks, defaulting to today when no day is given", async () => {
    const { env } = envWith({
      actions: [action("check", { startDate: day(1), endDate: day(1), part: "evening" }), action("check", { part: "whole" })],
    });
    expect(await parseCarRequests(env, "is the car free tomorrow evening? and today?")).toEqual([
      { type: "check", range: { startsAt: sg("2026-10-14T18:00"), endsAt: sg("2026-10-14T23:00") } },
      { type: "check", range: { startsAt: sg("2026-10-13T00:00"), endsAt: sg("2026-10-13T23:59:59") } },
    ]);
  });

  it("reads where / location / help / thanks", async () => {
    const { env } = envWith({ actions: [action("where"), action("location"), action("help"), action("thanks")] });
    expect(await parseCarRequests(env, "...")).toEqual([
      { type: "where" },
      { type: "location" },
      { type: "help" },
      { type: "thanks" },
    ]);
  });

  it("gives the model the current Singapore time and the Malay/Singlish words", async () => {
    const { env, ai } = envWith({ actions: [action("book", { startDate: day(0), startHour: 10 })] });
    await parseCarRequests(env, "need the car now");
    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    expect(systemPrompt).toContain("the time is 10:00");
    expect(systemPrompt).toContain('"esok" = tomorrow');
    expect(systemPrompt).toContain('"this weekend"');
  });

  it("books a specific date weeks ahead from the date the model writes, e.g. '6 Dec 3-8pm'", async () => {
    const { env, ai } = envWith({ actions: [action("book", { startDate: "2026-12-06", endDate: "2026-12-06", startHour: 15, endHour: 20 })] });
    expect(await parseCarRequests(env, "Add a booking for 6 Dec 3-8pm")).toEqual([
      { type: "book", range: { startsAt: sg("2026-12-06T15:00"), endsAt: sg("2026-12-06T20:00") } },
    ]);
    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    // The model gets two weeks of dates to copy weekdays from, not a list it has to count through.
    expect(systemPrompt).toContain("Tue 2026-10-13, Wed 2026-10-14");
    expect(systemPrompt).toContain('"today" = 2026-10-13. "tomorrow" = 2026-10-14.');
    expect(systemPrompt).not.toMatch(/\b\d+:(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/);
  });

  it("takes a date that already passed this year as next year's ('5 jan' in October)", async () => {
    const { env } = envWith({ actions: [action("book", { startDate: "2026-01-05", part: "whole" })] });
    expect(await parseCarRequests(env, "book 5 jan")).toEqual([
      { type: "book", range: { startsAt: sg("2027-01-05T00:00"), endsAt: sg("2027-01-05T23:59:59") } },
    ]);
  });

  it("spans the new year for a range like '30 dec - 2 jan'", async () => {
    const { env } = envWith({ actions: [action("book", { startDate: "2026-12-30", endDate: "2026-01-02", part: "whole" })] });
    expect(await parseCarRequests(env, "book 30 dec to 2 jan")).toEqual([
      { type: "book", range: { startsAt: sg("2026-12-30T00:00"), endsAt: sg("2027-01-02T23:59:59") } },
    ]);
  });

  it("flags a booking past the bookable horizon as too far, but not one just inside it", async () => {
    const { env } = envWith(
      { actions: [action("book", { startDate: "2027-06-06", startHour: 15, endHour: 20 })] },
      { actions: [action("book", { startDate: day(119), part: "whole" })] },
    );
    expect(await parseCarRequests(env, "book 6 jun")).toEqual([{ type: "book", range: null, tooFar: true }]);
    expect((await parseCarRequests(env, "book 9 feb"))?.[0]).toMatchObject({ type: "book", range: { startsAt: sg("2027-02-09T00:00") } });
  });

  it("rejects dates that don't exist, like 31 Nov", async () => {
    const { env } = envWith({ actions: [action("book", { startDate: "2026-11-31", part: "whole" })] });
    expect(await parseCarRequests(env, "book 31 nov")).toEqual([{ type: "book", range: null }]);
  });

  it("drops the range of a booking that has already ended", async () => {
    const { env } = envWith({ actions: [action("book", { startDate: day(0), endDate: day(0), startHour: 6, endHour: 8 })] });
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
    const { env, ai } = envWith({ actions: [action("book", { startDate: "2026-10-14", part: "evening" })] });
    const requests = await parseCarRequests(env, "book tonight");

    const systemPrompt = (ai.run.mock.calls[0] as any[])[1].messages[0].content as string;
    expect(systemPrompt).toContain("Today is Wed 2026-10-14");
    expect(requests).toEqual([
      { type: "book", range: { startsAt: sg("2026-10-14T18:00"), endsAt: sg("2026-10-14T23:00") } },
    ]);
  });
});
