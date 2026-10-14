import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { handleUpdate } from "@/worker/telegram/webhook";
import { cancelBooking } from "@/worker/core/bookings";
import type { Env } from "@/worker/env";
import { action, captureTelegram, fakeAI, fakeD1, makeEnv, sg, type SentCall } from "./helpers";

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
