import type { Env } from "../env";
import { getCarStatus, setCarLocation } from "../core/car";
import { cancelBooking, createBooking, currentOrNextBooking, listBookings, upcomingBookingsForUser } from "../core/bookings";
import { addUser, resolveAuthorizedUser } from "../core/users";
import { answerCallbackQuery, downloadFile, escapeHtml, sendMessage, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api";
import { formatRange, notifyBooked, notifyCancelled, notifyLocation, statusLine } from "./notify";
import { parseLevel } from "./parse";
import { looksLikeBooking, looksLikeCancel, looksLikeView, mightBeRequest, parseCarRequests, type TimeRange } from "./booking-intent";
import type { Booking } from "@/shared/types";
import type { User } from "../core/users";

/** Entry point for POST /telegram/webhook. Telegram retries on non-2xx, so we always 200. */
export async function handleUpdate(env: Env, update: TgUpdate, appUrl: string): Promise<void> {
  try {
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return;
    }
    const message = update.message;
    if (!message?.from || message.from.id === 0) return;
    await handleMessage(env, message, appUrl);
  } catch (err) {
    console.error("webhook handler failed", err);
  }
}

async function handleMessage(env: Env, message: TgMessage, appUrl: string): Promise<void> {
  const from = message.from!;
  const isPrivate = message.chat.type === "private";
  const text = message.text?.trim() ?? "";
  const command = text.startsWith("/") ? text.split(/[\s@]/)[0] : null;

  // /id works for everyone, anywhere — it's how you discover user and group ids during setup.
  if (command === "/id") {
    await sendMessage(
      env,
      message.chat.id,
      `Your Telegram id: <code>${from.id}</code>\n` +
        (isPrivate ? "" : `This chat's id: <code>${message.chat.id}</code>`),
    );
    return;
  }

  // /start works for everyone — it's how new users ask to be let in.
  if (command === "/start") {
    const user = await resolveAuthorizedUser(env, from.id, from.first_name);
    if (!user) {
      await sendMessage(
        env,
        message.chat.id,
        `Hi ${escapeHtml(from.first_name)}! This is a private family car bot.\n` +
          `Ask the admin to add you. Your Telegram id is <code>${from.id}</code>.`,
      );
      return;
    }
    await sendMessage(
      env,
      message.chat.id,
      `Hey ${escapeHtml(user.firstName)}! Send me a parking level (text or voice note) ` +
        `to update where the car is, or /where to check on it. ` +
        `You can also just ask me things, like “is the car free tonight?” or “book tomorrow 2pm”. /help shows more.`,
      {
        replyMarkup: isPrivate
          ? {
              inline_keyboard: [
                [{ text: "\u{1F4C5} Open schedule", web_app: { url: appUrl } }],
              ],
            }
          : undefined,
      },
    );
    return;
  }

  // Everything below requires whitelist membership.
  const user = await resolveAuthorizedUser(env, from.id, from.first_name);
  if (!user) {
    if (isPrivate) {
      await sendMessage(
        env,
        message.chat.id,
        `You're not on the list. Your Telegram id is <code>${from.id}</code> — send it to the admin.`,
      );
    }
    return;
  }

  if (command === "/where") {
    await sendWhere(env, message);
    return;
  }

  if (command === "/help") {
    await sendMessage(env, message.chat.id, HELP_TEXT);
    return;
  }

  if (command === "/add") {
    if (!user.isAdmin) {
      await sendMessage(env, message.chat.id, "Only the admin can add people.");
      return;
    }
    const match = text.match(/^\/add(?:@\w+)?\s+(\d+)\s+(.+)$/);
    if (!match) {
      await sendMessage(env, message.chat.id, "Usage: <code>/add 123456789 Name</code>");
      return;
    }
    const newId = Number(match[1]);
    const name = match[2].trim();
    await addUser(env, newId, name);
    await sendMessage(env, message.chat.id, `Added <b>${escapeHtml(name)}</b> ✅`);
    return;
  }

  if (command === "/app" || command === "/calendar") {
    await sendSchedule(env, message, appUrl);
    return;
  }

  if (command === "/bookings") {
    await handleListIntent(env, message, user.telegramId, "mine");
    return;
  }

  // Voice notes are read like typed text in private chats; in the group they can only update the location.
  if (message.voice) {
    if (message.voice.duration > 30) {
      if (isPrivate) await sendMessage(env, message.chat.id, "That's a long one — keep it short, like “parked at 4B”.");
      return;
    }
    const transcript = await transcribe(env, message.voice.file_id);
    if (isPrivate) await handleText(env, message, user, transcript, appUrl, true);
    else await handleLocationText(env, message, user.firstName, user.telegramId, transcript, true);
    return;
  }

  // In the group, plain text is only ever a parking update, and failures stay silent.
  if (text && !command) {
    if (isPrivate) await handleText(env, message, user, text, appUrl, false);
    else await handleLocationText(env, message, user.firstName, user.telegramId, text, false);
    return;
  }

  if (command && isPrivate) {
    await sendMessage(env, message.chat.id, "I know /where, /calendar, /bookings, /help, /add and /id.");
  }
}

const HELP_TEXT =
  `Here's what I can do — type it or send a voice note:\n\n` +
  `\u{1F4CD} <b>Parking</b>: “4B”, “parked at B2”\n` +
  `\u{1F697} <b>Where's the car?</b> “where's the car?” or /where\n` +
  `\u{1F50E} <b>Is it free?</b> “is the car free tomorrow evening?”\n` +
  `\u{1F4C5} <b>Book</b>: “book tonight 7pm”, “book sat 2pm to 6pm”, “need the car now for 2 hours”\n` +
  `❌ <b>Cancel</b>: “cancel my booking”, “cancel wednesday”\n` +
  `\u{1F4CB} <b>Bookings</b>: “my bookings”, “who has the car this week?” or /bookings\n` +
  `\u{1F5D3} <b>Schedule</b>: /calendar\n\n` +
  `You can mix them: “cancel wednesday and book tonight”.`;

/** Private-chat text or a voice transcript. */
async function handleText(
  env: Env,
  message: TgMessage,
  user: User,
  text: string,
  appUrl: string,
  fromVoice: boolean,
): Promise<void> {
  // A plain parking level ("4B", "parked at B2") skips the model.
  if (parseLevel(text) && !mightBeRequest(text)) {
    await handleLocationText(env, message, user.firstName, user.telegramId, text, true);
    return;
  }
  await handleRequests(env, message, user, text, appUrl, fromVoice);
}

async function sendWhere(env: Env, message: TgMessage): Promise<void> {
  const [status, next] = await Promise.all([
    getCarStatus(env),
    currentOrNextBooking(env, Math.floor(Date.now() / 1000)),
  ]);
  await sendMessage(env, message.chat.id, statusLine(status, next));
}

async function handleLocationText(
  env: Env,
  message: TgMessage,
  userName: string,
  userId: number,
  text: string,
  replyOnFailure: boolean,
): Promise<void> {
  const level = parseLevel(text);
  if (!level) {
    if (replyOnFailure) {
      await sendMessage(
        env,
        message.chat.id,
        `I heard: “${escapeHtml(text)}” — but couldn't find a level in it.\n` +
          `Try something like <b>4B</b> or “parked at level 4B”.`,
      );
    }
    return;
  }
  await setCarLocation(env, level, userId);
  await sendMessage(env, message.chat.id, `\u{1F4CD} Got it — car is at <b>${escapeHtml(level)}</b>`);
  await notifyLocation(env, level, userName, userId);
}

/**
 * The model says what the message wants, which can be several things
 * ("Cancel my Wednesday booking, book tonight instead"). If it can't tell,
 * fall back on keywords, then on the help text.
 */
async function handleRequests(
  env: Env,
  message: TgMessage,
  user: User,
  text: string,
  appUrl: string,
  fromVoice: boolean,
): Promise<void> {
  const userId = user.telegramId;
  const requests = await parseCarRequests(env, text);
  if (!requests) {
    if (looksLikeCancel(text)) await handleCancelIntent(env, message, userId, "unclear");
    else if (looksLikeBooking(text)) await handleBookingIntent(env, message, userId, null);
    else if (looksLikeView(text)) await sendSchedule(env, message, appUrl);
    else if (parseLevel(text)) await handleLocationText(env, message, user.firstName, userId, text, true);
    else {
      const heard = fromVoice ? `I heard: “${escapeHtml(text)}”. ` : "";
      await sendMessage(env, message.chat.id, `\u{1F914} ${heard}Not sure what you mean.\n\n${HELP_TEXT}`);
    }
    return;
  }
  for (const request of requests) {
    switch (request.type) {
      case "cancel":
        await handleCancelIntent(env, message, userId, request.when);
        break;
      case "list":
        await handleListIntent(env, message, userId, request.whose);
        break;
      case "calendar":
        await sendSchedule(env, message, appUrl);
        break;
      case "check":
        await handleCheckIntent(env, message, userId, request.range);
        break;
      case "where":
        await sendWhere(env, message);
        break;
      case "location":
        await handleLocationText(env, message, user.firstName, userId, text, true);
        break;
      case "help":
        await sendMessage(env, message.chat.id, HELP_TEXT);
        break;
      case "thanks":
        await sendMessage(env, message.chat.id, "\u{1F44D}");
        break;
      case "book":
        await handleBookingIntent(env, message, userId, request.range);
        break;
    }
  }
}

const MIN_FREE_GAP_SECONDS = 30 * 60;
const MAX_FREE_BUTTONS = 3;

/** Bookings overlapping `range`, and the free gaps (30 min or longer) between them. */
async function availability(env: Env, range: TimeRange): Promise<{ busy: Booking[]; free: TimeRange[] }> {
  const busy = await listBookings(env, range.startsAt, range.endsAt);
  if (busy.length === 0) return { busy, free: [range] };
  const free: TimeRange[] = [];
  let cursor = range.startsAt;
  for (const b of busy) {
    if (b.startsAt - cursor >= MIN_FREE_GAP_SECONDS) free.push({ startsAt: cursor, endsAt: b.startsAt });
    cursor = Math.max(cursor, b.endsAt);
  }
  if (range.endsAt - cursor >= MIN_FREE_GAP_SECONDS) free.push({ startsAt: cursor, endsAt: range.endsAt });
  return { busy, free };
}

function takenLine(b: Booking, userId: number): string {
  const who = b.userId === userId ? "you" : escapeHtml(b.userName);
  return `· ${formatRange(b)} · ${who}`;
}

function bookFreeButtons(free: TimeRange[]) {
  return {
    inline_keyboard: free
      .slice(0, MAX_FREE_BUTTONS)
      .map((r) => [{ text: `\u{1F4C5} Book ${formatRange(r)}`, callback_data: `book:${r.startsAt}:${r.endsAt}` }]),
  };
}

/** "Is the car free tomorrow evening?" Only looks from now onwards. */
async function handleCheckIntent(env: Env, message: TgMessage, userId: number, range: TimeRange | null): Promise<void> {
  if (!range) {
    await sendMessage(env, message.chat.id, "Couldn't work out when you mean. Try “is the car free tomorrow evening?”");
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (range.endsAt <= now) {
    await sendMessage(env, message.chat.id, "That time has already passed.");
    return;
  }
  const window = { startsAt: Math.max(range.startsAt, now), endsAt: range.endsAt };
  const { busy, free } = await availability(env, window);
  if (busy.length === 0) {
    await sendMessage(env, message.chat.id, `✅ The car is free ${formatRange(window)}.`, {
      replyMarkup: bookFreeButtons(free),
    });
    return;
  }
  const taken = busy.map((b) => takenLine(b, userId)).join("\n");
  const freeText = free.length > 0 ? `Free:\n${free.map((r) => `· ${formatRange(r)}`).join("\n")}` : "No free time then.";
  await sendMessage(env, message.chat.id, `\u{1F697} Taken:\n${taken}\n\n${freeText}`, {
    replyMarkup: free.length > 0 ? bookFreeButtons(free) : undefined,
  });
}

/** The schedule Mini App button. Telegram only allows web_app buttons in private chats. */
async function sendSchedule(env: Env, message: TgMessage, appUrl: string): Promise<void> {
  if (message.chat.type !== "private") {
    await sendMessage(env, message.chat.id, "Message me privately and send /calendar to open the schedule.");
    return;
  }
  await sendMessage(env, message.chat.id, "Here you go:", {
    replyMarkup: { inline_keyboard: [[{ text: "\u{1F4C5} Open schedule", web_app: { url: appUrl } }]] },
  });
}

const LIST_WINDOW_SECONDS = 21 * 86_400; // matches how far ahead the schedule goes

/** Lists upcoming bookings: the sender's own, or everyone's for the next three weeks. */
async function handleListIntent(
  env: Env,
  message: TgMessage,
  userId: number,
  whose: "mine" | "everyone",
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (whose === "mine") {
    const mine = await upcomingBookingsForUser(env, userId, now);
    await sendMessage(
      env,
      message.chat.id,
      mine.length === 0
        ? "You have no upcoming bookings."
        : `\u{1F4C5} Your upcoming bookings:\n${mine.map((b) => `· ${formatRange(b)}`).join("\n")}`,
    );
    return;
  }
  const all = await listBookings(env, now, now + LIST_WINDOW_SECONDS);
  await sendMessage(
    env,
    message.chat.id,
    all.length === 0
      ? "No upcoming bookings — the car is free."
      : `\u{1F4C5} Upcoming bookings:\n${all.map((b) => `· ${formatRange(b)} · ${escapeHtml(b.userName)}`).join("\n")}`,
  );
}

const MAX_CANCEL_CHOICES = 8;

function cancelChoices(bookings: Booking[]) {
  return {
    inline_keyboard: [
      ...bookings
        .slice(0, MAX_CANCEL_CHOICES)
        .map((b) => [{ text: `❌ ${formatRange(b)}`, callback_data: `unbook:${b.id}` }]),
      [{ text: "Keep my bookings", callback_data: "unbook_keep" }],
    ],
  };
}

/** Cancels one of the user's own bookings. No date given → the soonest upcoming one. */
async function handleCancelIntent(
  env: Env,
  message: TgMessage,
  userId: number,
  when: TimeRange | "soonest" | "unclear",
): Promise<void> {
  const mine = await upcomingBookingsForUser(env, userId, Math.floor(Date.now() / 1000));
  if (mine.length === 0) {
    await sendMessage(env, message.chat.id, "You don't have any upcoming bookings to cancel.");
    return;
  }

  let matches: Booking[];
  if (when === "soonest") {
    matches = [mine[0]];
  } else if (when === "unclear") {
    await sendMessage(env, message.chat.id, "Couldn't work out which day you meant. Which booking should I cancel?", {
      replyMarkup: cancelChoices(mine),
    });
    return;
  } else {
    // The range is resolved in Singapore time; cancel whatever of ours overlaps it.
    matches = mine.filter((b) => b.startsAt < when.endsAt && b.endsAt > when.startsAt);
    if (matches.length === 0) {
      await sendMessage(env, message.chat.id, "You don't have a booking then. Your upcoming bookings:", {
        replyMarkup: cancelChoices(mine),
      });
      return;
    }
  }

  if (matches.length > 1) {
    await sendMessage(env, message.chat.id, "Which booking should I cancel?", {
      replyMarkup: cancelChoices(matches),
    });
    return;
  }

  const booking = matches[0];
  await sendMessage(env, message.chat.id, `\u{1F5D1} Cancel this booking?\n<b>${formatRange(booking)}</b>`, {
    replyMarkup: {
      inline_keyboard: [
        [
          { text: "✅ Yes, cancel it", callback_data: `unbook:${booking.id}` },
          { text: "Keep it", callback_data: "unbook_keep" },
        ],
      ],
    },
  });
}

async function handleBookingIntent(
  env: Env,
  message: TgMessage,
  userId: number,
  intent: TimeRange | null,
): Promise<void> {
  if (!intent) {
    await sendMessage(
      env,
      message.chat.id,
      `Couldn't work out the date/time. I understand:\n\n` +
        `<b>Whole days</b>\n` +
        `· "book tomorrow"\n` +
        `· "book this saturday whole day"\n` +
        `· "reserve 21-23 june"\n\n` +
        `<b>Time of day</b>\n` +
        `· "book tomorrow morning" (06:00–12:00)\n` +
        `· "book this friday afternoon" (12:00–18:00)\n` +
        `· "book tonight" (18:00–23:00)\n\n` +
        `<b>Specific hours</b>\n` +
        `· "book saturday 2pm to 6pm"\n` +
        `· "book tonight 7pm" (until 23:00)\n\n` +
        `<b>Relative days</b>\n` +
        `· today / tomorrow / this &lt;weekday&gt; / next &lt;weekday&gt;`,
    );
    return;
  }

  // Say who has it before offering a Confirm that would only fail. The sender's own
  // overlapping booking doesn't block: "cancel tonight, book tonight 8pm" cancels it first.
  const { busy, free } = await availability(env, intent);
  if (busy.some((b) => b.userId !== userId)) {
    const taken = busy.map((b) => takenLine(b, userId)).join("\n");
    const offer = free.length > 0 ? "\n\nFree in that window:" : "\n\nTry another time, or /calendar to see the schedule.";
    await sendMessage(env, message.chat.id, `⚠️ The car is already booked then:\n${taken}${offer}`, {
      replyMarkup: free.length > 0 ? bookFreeButtons(free) : undefined,
    });
    return;
  }

  const fmt = (unix: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Singapore",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(unix * 1000));

  const ownNote =
    busy.length > 0
      ? `\n<i>This overlaps your booking ${busy.map((b) => formatRange(b)).join(", ")}. Cancel that first.</i>`
      : "";
  await sendMessage(
    env,
    message.chat.id,
    `\u{1F4C5} Book the car?\n<b>${fmt(intent.startsAt)} – ${fmt(intent.endsAt)}</b>${ownNote}`,
    {
      replyMarkup: {
        inline_keyboard: [
          [
            { text: "✅ Confirm", callback_data: `book:${intent.startsAt}:${intent.endsAt}` },
            { text: "❌ Cancel", callback_data: "book_cancel" },
          ],
        ],
      },
    },
  );
}

async function handleCallbackQuery(env: Env, cb: TgCallbackQuery): Promise<void> {
  const chatId = cb.message?.chat.id;
  if (!chatId) {
    await answerCallbackQuery(env, cb.id);
    return;
  }

  if (cb.data === "book_cancel") {
    await answerCallbackQuery(env, cb.id, "Not booked.");
    await sendMessage(env, chatId, "Okay, not booked.");
    return;
  }

  if (cb.data === "unbook_keep") {
    await answerCallbackQuery(env, cb.id, "Kept.");
    await sendMessage(env, chatId, "Okay, booking kept.");
    return;
  }

  const unbook = cb.data?.match(/^unbook:(\d+)$/);
  if (unbook) {
    const user = await resolveAuthorizedUser(env, cb.from.id, cb.from.first_name);
    if (!user) {
      await answerCallbackQuery(env, cb.id, "Not authorised.");
      return;
    }
    const cancelled = await cancelBooking(env, Number(unbook[1]), user.telegramId);
    if (!cancelled) {
      await answerCallbackQuery(env, cb.id);
      await sendMessage(env, chatId, "Couldn't find that booking — it may already be cancelled.");
      return;
    }
    await answerCallbackQuery(env, cb.id, "Cancelled!");
    await notifyCancelled(env, cancelled);
    return;
  }

  const match = cb.data?.match(/^book:(\d+):(\d+)$/);
  if (!match) {
    await answerCallbackQuery(env, cb.id);
    return;
  }

  const user = await resolveAuthorizedUser(env, cb.from.id, cb.from.first_name);
  if (!user) {
    await answerCallbackQuery(env, cb.id, "Not authorised.");
    return;
  }

  const startsAt = Number(match[1]);
  const endsAt = Number(match[2]);
  const result = await createBooking(env, user.telegramId, startsAt, endsAt);

  if (!result.ok) {
    await answerCallbackQuery(env, cb.id);
    await sendMessage(
      env,
      chatId,
      result.reason === "overlap"
        ? "❌ That slot is already booked."
        : "❌ Booking failed — time may have passed.",
    );
    return;
  }

  await answerCallbackQuery(env, cb.id, "Booked!");
  await sendMessage(env, chatId, `✅ Booked.`);
  await notifyBooked(env, result.booking);
}

async function transcribe(env: Env, fileId: string): Promise<string> {
  const audio = await downloadFile(env, fileId);
  const bytes = new Uint8Array(audio);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
    audio: btoa(binary),
  });
  return result.text ?? "";
}
