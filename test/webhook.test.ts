import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleUpdate } from "@/worker/telegram/webhook";
import { cancelBooking } from "@/worker/core/bookings";
import type { Env } from "@/worker/env";
import { action, captureTelegram, fakeAI, fakeD1, makeEnv, sg, whisper, type SentCall } from "./helpers";
import { notifyReminder } from "@/worker/telegram/notify";

// Tuesday 13 Oct 2026, 10:00 in Singapore. Day index 0 = Tue 13, 1 = Wed 14, ...
const NOW = sg("2026-10-13T10:00");
const FATIM = { id: 111, first_name: "Fatim" };
const SIBLING = { id: 222, first_name: "Sam" };

let db: DatabaseSync;
let calls: SentCall[];
let consoleError: ReturnType<typeof vi.spyOn>;
let updateId = 0;

function setup(...aiReplies: unknown[]): { env: Env; ai: ReturnType<typeof fakeAI> } {
  const fake = fakeD1();
  db = fake.db;
  db.exec(`INSERT INTO users (telegram_id, first_name) VALUES (${FATIM.id}, 'Fatim'), (${SIBLING.id}, 'Sam')`);
  const ai = fakeAI(...aiReplies);
  return { env: makeEnv(fake.d1, ai), ai };
}

function addBooking(userId: number, from: string, to: string): number {
  const r = db
    .prepare("INSERT INTO bookings (user_id, starts_at, ends_at) VALUES (?, ?, ?)")
    .run(userId, sg(from), sg(to));
  return Number(r.lastInsertRowid);
}

function bookingIds(): number[] {
  return (db.prepare("SELECT id FROM bookings ORDER BY id").all() as { id: number }[]).map((r) => r.id);
}

async function sendText(env: Env, text: string, from = FATIM, chatType: "private" | "group" = "private") {
  await handleUpdate(
    env,
    { update_id: ++updateId, message: { message_id: updateId, from, chat: { id: from.id, type: chatType }, text } },
    "https://app.example",
  );
}

async function press(env: Env, data: string, from = FATIM) {
  await handleUpdate(
    env,
    {
      update_id: ++updateId,
      callback_query: { id: `cb${updateId}`, from, data, message: { message_id: 1, chat: { id: from.id, type: "private" } } },
    },
    "https://app.example",
  );
}

const messages = () => calls.filter((c) => c.method === "sendMessage");
const buttons = (call: SentCall): string[] =>
  (call.body.reply_markup?.inline_keyboard ?? []).flat().map((b: { callback_data?: string }) => b.callback_data);

describe("cancelling bookings by text", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    calls = captureTelegram();
    consoleError = vi.spyOn(console, "error");
  });
  afterEach(() => {
    // handleUpdate swallows errors so Telegram doesn't retry; surface them here instead.
    expect(consoleError).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("handles both intents in 'Cancel my booking for Wednesday. Book for tonight instead'", async () => {
    const { env } = setup({
      actions: [
        action("cancel", { startDay: 1, endDay: 1, part: "whole" }),
        action("book", { startDay: 0, endDay: 0, part: "evening" }),
      ],
    });
    const wed = addBooking(FATIM.id, "2026-10-14T00:00", "2026-10-14T23:59:59");

    await sendText(env, "Cancel my booking for Wednesday. Book for tonight instead");

    const [cancelPrompt, bookPrompt] = messages();
    expect(messages()).toHaveLength(2);
    expect(cancelPrompt.body.text).toContain("Cancel this booking?");
    expect(cancelPrompt.body.text).toContain("Wed 14 Oct");
    expect(buttons(cancelPrompt)).toEqual([`unbook:${wed}`, "unbook_keep"]);
    expect(bookPrompt.body.text).toContain("Book the car?");
    expect(buttons(bookPrompt)).toEqual([`book:${sg("2026-10-13T18:00")}:${sg("2026-10-13T23:00")}`, "book_cancel"]);

    // Confirm both: Wednesday is gone, tonight is booked.
    await press(env, buttons(cancelPrompt)[0]);
    await press(env, buttons(bookPrompt)[0]);
    const rows = db.prepare("SELECT user_id, starts_at, ends_at FROM bookings").all();
    expect(rows).toEqual([{ user_id: FATIM.id, starts_at: sg("2026-10-13T18:00"), ends_at: sg("2026-10-13T23:00") }]);
  });

  it("with no date, picks the user's soonest upcoming booking — not someone else's", async () => {
    const { env } = setup({ actions: [action("cancel")] });
    addBooking(SIBLING.id, "2026-10-13T12:00", "2026-10-13T14:00"); // earlier, but not Fatim's
    addBooking(FATIM.id, "2026-10-08T09:00", "2026-10-08T12:00"); // Fatim's, but already over
    const sat = addBooking(FATIM.id, "2026-10-17T14:00", "2026-10-17T18:00");
    const thu = addBooking(FATIM.id, "2026-10-15T09:00", "2026-10-15T12:00");

    await sendText(env, "cancel my booking");

    expect(messages()).toHaveLength(1);
    expect(buttons(messages()[0])).toEqual([`unbook:${thu}`, "unbook_keep"]);
    expect(bookingIds()).toContain(sat);
  });

  it("offers the user's bookings when they have none on the named day", async () => {
    const { env } = setup({ actions: [action("cancel", { startDay: 2, endDay: 2, part: "whole" })] }); // Thu
    const wed = addBooking(FATIM.id, "2026-10-14T00:00", "2026-10-14T23:59:59");
    const sat = addBooking(FATIM.id, "2026-10-17T14:00", "2026-10-17T18:00");

    await sendText(env, "cancel thursday");

    expect(messages()[0].body.text).toContain("You don't have a booking then");
    expect(buttons(messages()[0])).toEqual([`unbook:${wed}`, `unbook:${sat}`, "unbook_keep"]);
  });

  it("asks which one when several bookings fall on the named day", async () => {
    const { env } = setup({ actions: [action("cancel", { startDay: 4, endDay: 4, part: "whole" })] }); // Sat
    const morning = addBooking(FATIM.id, "2026-10-17T08:00", "2026-10-17T10:00");
    const evening = addBooking(FATIM.id, "2026-10-17T19:00", "2026-10-17T21:00");

    await sendText(env, "cancel saturday");

    expect(messages()[0].body.text).toContain("Which booking should I cancel?");
    expect(buttons(messages()[0])).toEqual([`unbook:${morning}`, `unbook:${evening}`, "unbook_keep"]);
  });

  it("falls back to a list of bookings when the model can't parse a cancel", async () => {
    const { env } = setup(new Error("AI down"));
    const wed = addBooking(FATIM.id, "2026-10-14T00:00", "2026-10-14T23:59:59");

    await sendText(env, "cancel the thing");

    expect(messages()[0].body.text).toContain("Couldn't work out which day");
    expect(buttons(messages()[0])).toEqual([`unbook:${wed}`, "unbook_keep"]);
  });

  it("says so when there is nothing to cancel", async () => {
    const { env } = setup({ actions: [action("cancel")] });
    await sendText(env, "cancel my booking");
    expect(messages()[0].body.text).toBe("You don't have any upcoming bookings to cancel.");
  });

  it("confirming deletes the booking and tells everyone", async () => {
    const { env } = setup();
    const wed = addBooking(FATIM.id, "2026-10-14T00:00", "2026-10-14T23:59:59");

    await press(env, `unbook:${wed}`);

    expect(bookingIds()).toEqual([]);
    const sent = messages().map((m) => [String(m.body.chat_id), m.body.text]);
    expect(sent).toContainEqual([String(FATIM.id), expect.stringContaining("Cancelled")]);
    expect(sent).toContainEqual([String(SIBLING.id), expect.stringContaining("Fatim</b> cancelled")]);
  });

  it("won't cancel someone else's booking", async () => {
    const { env } = setup();
    const theirs = addBooking(SIBLING.id, "2026-10-14T00:00", "2026-10-14T23:59:59");

    await press(env, `unbook:${theirs}`, FATIM);

    expect(bookingIds()).toEqual([theirs]);
    expect(messages()[0].body.text).toContain("Couldn't find that booking");
  });

  it("'Keep it' leaves the booking alone", async () => {
    const { env } = setup();
    const wed = addBooking(FATIM.id, "2026-10-14T00:00", "2026-10-14T23:59:59");
    await press(env, "unbook_keep");
    expect(bookingIds()).toEqual([wed]);
    expect(messages()[0].body.text).toBe("Okay, booking kept.");
  });

  it("'Find my upcoming bookings' lists only the user's own upcoming bookings, soonest first", async () => {
    const { env } = setup({ actions: [action("list", { whose: "mine" })] });
    addBooking(FATIM.id, "2026-10-08T09:00", "2026-10-08T12:00"); // over
    addBooking(SIBLING.id, "2026-10-14T09:00", "2026-10-14T12:00"); // not Fatim's
    addBooking(FATIM.id, "2026-10-17T14:00", "2026-10-17T18:00");
    addBooking(FATIM.id, "2026-10-15T19:00", "2026-10-15T23:00");

    await sendText(env, "Find my upcoming bookings");

    expect(messages()).toHaveLength(1);
    expect(messages()[0].body.text).toBe(
      "\u{1F4C5} Your upcoming bookings:\n· Thu 15 Oct, 19:00–23:00\n· Sat 17 Oct, 14:00–18:00",
    );
  });

  it("lists everyone's bookings with names when asked who has the car", async () => {
    const { env } = setup({ actions: [action("list", { whose: "everyone" })] });
    addBooking(SIBLING.id, "2026-10-14T09:00", "2026-10-14T12:00");
    addBooking(FATIM.id, "2026-10-15T19:00", "2026-10-15T23:00");

    await sendText(env, "who has the car this week? show all bookings");

    expect(messages()[0].body.text).toBe(
      "\u{1F4C5} Upcoming bookings:\n· Wed 14 Oct, 09:00–12:00 · Sam\n· Thu 15 Oct, 19:00–23:00 · Fatim",
    );
  });

  it("says so when there are no bookings to list", async () => {
    const { env } = setup({ actions: [action("list", { whose: "mine" })] });
    await sendText(env, "my bookings");
    expect(messages()[0].body.text).toBe("You have no upcoming bookings.");
  });

  it("/bookings lists bookings without calling the model", async () => {
    const { env, ai } = setup();
    addBooking(FATIM.id, "2026-10-15T19:00", "2026-10-15T23:00");
    await sendText(env, "/bookings");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()[0].body.text).toContain("Thu 15 Oct, 19:00–23:00");
  });

  it.each(["Show me the calendar", "open the app", "show menu"])("'%s' sends the schedule button", async (text) => {
    const { env } = setup({ actions: [action("calendar")] });
    await sendText(env, text);
    const button = messages()[0].body.reply_markup.inline_keyboard[0][0];
    expect(button.web_app).toEqual({ url: "https://app.example" });
  });

  it("/calendar sends the schedule button without calling the model", async () => {
    const { env, ai } = setup();
    await sendText(env, "/calendar");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()[0].body.reply_markup.inline_keyboard[0][0].web_app).toEqual({ url: "https://app.example" });
  });

  it("falls back to the schedule button when the model fails on a calendar request", async () => {
    const { env } = setup(new Error("AI down"));
    await sendText(env, "Show me the calendar");
    expect(messages()[0].body.reply_markup.inline_keyboard[0][0].web_app).toEqual({ url: "https://app.example" });
  });

  it("handles a list alongside a cancel in one message", async () => {
    const { env } = setup({ actions: [action("cancel"), action("list", { whose: "mine" })] });
    const thu = addBooking(FATIM.id, "2026-10-15T19:00", "2026-10-15T23:00");

    await sendText(env, "cancel my booking and show my bookings");

    expect(buttons(messages()[0])).toEqual([`unbook:${thu}`, "unbook_keep"]);
    expect(messages()[1].body.text).toContain("Your upcoming bookings");
  });

  it("in a group, /calendar points to a private chat instead of sending a web_app button", async () => {
    const { env } = setup();
    await sendText(env, "/calendar", FATIM, "group");
    expect(messages()[0].body.text).toContain("Message me privately");
    expect(messages()[0].body.reply_markup).toBeUndefined();
  });

  it("keeps a parking update that merely mentions the app", async () => {
    const { env, ai } = setup();
    await sendText(env, "parked at 4B, update the app");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()[0].body.text).toContain("car is at <b>4B</b>");
  });

  it("'where's the car?' answers with the location and who has it", async () => {
    const { env } = setup({ actions: [action("where")] });
    db.exec(`INSERT INTO car_status (id, level, updated_by, updated_at) VALUES (1, 'B2', ${SIBLING.id}, ${NOW - 3600})`);
    addBooking(SIBLING.id, "2026-10-13T09:00", "2026-10-13T12:00");

    await sendText(env, "where's the car?");

    expect(messages()[0].body.text).toContain("<b>B2</b> · left by Sam, 1h ago");
    expect(messages()[0].body.text).toContain("In use by <b>Sam</b>");
  });

  it("'is the car free tomorrow evening?' says free and offers a Book it button", async () => {
    const { env } = setup({ actions: [action("check", { startDay: 1, endDay: 1, part: "evening" })] });

    await sendText(env, "is the car free tomorrow evening?");

    expect(messages()[0].body.text).toBe("✅ The car is free Wed 14 Oct, 18:00–23:00.");
    expect(buttons(messages()[0])).toEqual([`book:${sg("2026-10-14T18:00")}:${sg("2026-10-14T23:00")}`]);
  });

  it("when busy, says who has it and offers the free gaps", async () => {
    const { env } = setup({ actions: [action("check", { startDay: 1, endDay: 1, part: "evening" })] });
    addBooking(SIBLING.id, "2026-10-14T19:00", "2026-10-14T20:30");

    await sendText(env, "anyone using the car tomorrow night?");

    expect(messages()[0].body.text).toBe(
      "\u{1F697} Taken:\n· Wed 14 Oct, 19:00–20:30 · Sam\n\nFree:\n· Wed 14 Oct, 18:00–19:00\n· Wed 14 Oct, 20:30–23:00",
    );
    expect(buttons(messages()[0])).toEqual([
      `book:${sg("2026-10-14T18:00")}:${sg("2026-10-14T19:00")}`,
      `book:${sg("2026-10-14T20:30")}:${sg("2026-10-14T23:00")}`,
    ]);
  });

  it("a check for today only looks from now onwards", async () => {
    const { env } = setup({ actions: [action("check", { startDay: 0, part: "whole" })] });
    await sendText(env, "is the car free today?");
    expect(messages()[0].body.text).toBe("✅ The car is free Tue 13 Oct, 10:00–23:59.");
  });

  it("a weekend check shows both days", async () => {
    const { env } = setup({ actions: [action("check", { startDay: 4, endDay: 5, part: "whole" })] });
    await sendText(env, "is the car free this weekend?");
    expect(messages()[0].body.text).toBe("✅ The car is free Sat 17 Oct, 00:00–Sun 18 Oct, 23:59.");
  });

  it("tapping a Book it button books that slot", async () => {
    const { env } = setup();
    await press(env, `book:${sg("2026-10-14T18:00")}:${sg("2026-10-14T23:00")}`);
    expect(db.prepare("SELECT user_id, starts_at, ends_at FROM bookings").all()).toEqual([
      { user_id: FATIM.id, starts_at: sg("2026-10-14T18:00"), ends_at: sg("2026-10-14T23:00") },
    ]);
  });

  it("a booking that clashes with someone else says who has it instead of offering Confirm", async () => {
    const { env } = setup({ actions: [action("book", { startDay: 1, endDay: 1, part: "evening" })] });
    addBooking(SIBLING.id, "2026-10-14T18:00", "2026-10-14T20:00");

    await sendText(env, "book tomorrow night");

    expect(messages()[0].body.text).toContain("⚠️ The car is already booked then:\n· Wed 14 Oct, 18:00–20:00 · Sam");
    expect(buttons(messages()[0])).toEqual([`book:${sg("2026-10-14T20:00")}:${sg("2026-10-14T23:00")}`]);
  });

  it("a booking for a part of today that has started begins now, ignoring bookings that already ended", async () => {
    const { env } = setup({ actions: [action("book", { startDay: 0, endDay: 0, part: "morning" })] });
    addBooking(SIBLING.id, "2026-10-13T07:00", "2026-10-13T09:00"); // over by 10:00

    await sendText(env, "book this morning");

    expect(messages()[0].body.text).toContain("Book the car?\n<b>Tue 13 Oct, 10:00 – Tue 13 Oct, 12:00</b>");
    expect(buttons(messages()[0])[0]).toBe(`book:${sg("2026-10-13T10:00")}:${sg("2026-10-13T12:00")}`);
  });

  it("an overlap with the sender's own booking still offers Confirm, with a note", async () => {
    const { env } = setup({
      actions: [action("cancel", { startDay: 0, part: "evening" }), action("book", { startDay: 0, startHour: 20 })],
    });
    const tonight = addBooking(FATIM.id, "2026-10-13T18:00", "2026-10-13T23:00");

    await sendText(env, "cancel tonight and book tonight 8pm instead");

    expect(buttons(messages()[0])).toEqual([`unbook:${tonight}`, "unbook_keep"]);
    expect(messages()[1].body.text).toContain("Book the car?");
    expect(messages()[1].body.text).toContain("overlaps your booking Tue 13 Oct, 18:00–23:00");
    expect(buttons(messages()[1])[0]).toBe(`book:${sg("2026-10-13T20:00")}:${sg("2026-10-13T23:00")}`);
  });

  it("messages without keywords now reach the model", async () => {
    const { env, ai } = setup({ actions: [action("check", { startDay: 0, part: "evening" })] });
    await sendText(env, "can I take the car later");
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(messages()[0].body.text).toContain("free");
  });

  it.each([
    ["hi", "help", "Here's what I can do"],
    ["thanks!", "thanks", "\u{1F44D}"],
  ])("'%s' → %s", async (text, type, reply) => {
    const { env } = setup({ actions: [action(type as "help" | "thanks")] });
    await sendText(env, text);
    expect(messages()[0].body.text).toContain(reply);
  });

  it("falls back to the help text when nothing makes sense, instead of 'couldn't find a level'", async () => {
    const { env } = setup({ error: "unclear" });
    await sendText(env, "blah blah");
    expect(messages()[0].body.text).toContain("Not sure what you mean");
    expect(messages()[0].body.text).toContain("Here's what I can do");
    expect(messages()[0].body.text).not.toContain("couldn't find a level");
  });

  it("a parking update phrased as a question goes through the model and is still saved", async () => {
    const { env } = setup({ actions: [action("location")] });
    await sendText(env, "left the car at B2 near the lift, ok?");
    expect(db.prepare("SELECT level FROM car_status").get()).toEqual({ level: "B2" });
  });

  it("a voice note asking to book is read like text", async () => {
    const { env } = setup(whisper("book tomorrow at 2pm"), { actions: [action("book", { startDay: 1, startHour: 14 })] });
    await handleUpdate(
      env,
      { update_id: ++updateId, message: { message_id: 1, from: FATIM, chat: { id: FATIM.id, type: "private" }, voice: { file_id: "f", duration: 3 } } },
      "https://app.example",
    );
    expect(messages()[0].body.text).toContain("Book the car?");
    expect(buttons(messages()[0])[0]).toBe(`book:${sg("2026-10-14T14:00")}:${sg("2026-10-14T18:00")}`);
  });

  it("a misheard voice note echoes what was heard", async () => {
    const { env } = setup(whisper("purple monkey"), { error: "unclear" });
    await handleUpdate(
      env,
      { update_id: ++updateId, message: { message_id: 1, from: FATIM, chat: { id: FATIM.id, type: "private" }, voice: { file_id: "f", duration: 3 } } },
      "https://app.example",
    );
    expect(messages()[0].body.text).toContain("I heard: “purple monkey”");
  });

  it("/help shows the help text without calling the model", async () => {
    const { env, ai } = setup();
    await sendText(env, "/help");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()[0].body.text).toContain("Here's what I can do");
  });

  it("group text stays a silent location parser", async () => {
    const { env, ai } = setup();
    await sendText(env, "anyone free for lunch?", SIBLING, "group");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()).toHaveLength(0);
  });

  it("the reminder says where the car is", async () => {
    const { env } = setup();
    db.exec(`INSERT INTO car_status (id, level, updated_by, updated_at) VALUES (1, '4B', ${SIBLING.id}, ${NOW})`);
    const id = addBooking(FATIM.id, "2026-10-13T10:20", "2026-10-13T12:00");
    await notifyReminder(env, { id, userId: FATIM.id, userName: "Fatim", startsAt: sg("2026-10-13T10:20"), endsAt: sg("2026-10-13T12:00") });
    expect(messages()[0].body.text).toBe("⏰ Your booking starts at Tue 10:20 · car is at <b>4B</b>");
  });

  it("doesn't call the model for a plain location update", async () => {
    const { env, ai } = setup();
    await sendText(env, "4B");
    expect(ai.run).not.toHaveBeenCalled();
    expect(messages()[0].body.text).toContain("car is at <b>4B</b>");
  });
});

describe("cancelBooking", () => {
  it("reports a double-tapped cancel only once", async () => {
    const { db, d1 } = fakeD1();
    db.exec(`INSERT INTO users (telegram_id, first_name) VALUES (${FATIM.id}, 'Fatim')`);
    const env = makeEnv(d1, fakeAI());
    const id = Number(
      db.prepare("INSERT INTO bookings (user_id, starts_at, ends_at) VALUES (?, ?, ?)").run(FATIM.id, 1, 2).lastInsertRowid,
    );

    // Both calls read the row before either deletes it, as two concurrent webhook deliveries can.
    const results = await Promise.all([cancelBooking(env, id, FATIM.id), cancelBooking(env, id, FATIM.id)]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
