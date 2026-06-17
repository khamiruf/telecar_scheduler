import type { Env } from "../env";
import { getCarStatus, setCarLocation } from "../core/car";
import { createBooking, currentOrNextBooking } from "../core/bookings";
import { addUser, resolveAuthorizedUser } from "../core/users";
import { answerCallbackQuery, downloadFile, escapeHtml, sendMessage, type TgCallbackQuery, type TgMessage, type TgUpdate } from "./api";
import { notifyBooked, notifyLocation, statusLine } from "./notify";
import { parseLevel } from "./parse";
import { looksLikeBooking, parseBookingIntent } from "./booking-intent";

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
        `to update where the car is, or /where to check on it.`,
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
    const [status, next] = await Promise.all([
      getCarStatus(env),
      currentOrNextBooking(env, Math.floor(Date.now() / 1000)),
    ]);
    await sendMessage(env, message.chat.id, statusLine(status, next));
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

  if (command === "/app") {
    await sendMessage(env, message.chat.id, "Here you go:", {
      replyMarkup: {
        inline_keyboard: [[{ text: "\u{1F4C5} Open schedule", web_app: { url: appUrl } }]],
      },
    });
    return;
  }

  // Voice note -> transcribe -> treat as a location update.
  if (message.voice) {
    if (message.voice.duration > 30) {
      if (isPrivate) await sendMessage(env, message.chat.id, "That's a long one — keep it short, like “parked at 4B”.");
      return;
    }
    const transcript = await transcribe(env, message.voice.file_id);
    await handleLocationText(env, message, user.firstName, user.telegramId, transcript, true);
    return;
  }

  // Plain text: check booking intent first (private chat only), then try location parse.
  if (text && !command) {
    if (isPrivate && looksLikeBooking(text)) {
      await handleBookingIntent(env, message, text);
      return;
    }
    await handleLocationText(env, message, user.firstName, user.telegramId, text, isPrivate);
    return;
  }

  if (command && isPrivate) {
    await sendMessage(env, message.chat.id, "I know /where, /app, /add and /id.");
  }
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

async function handleBookingIntent(env: Env, message: TgMessage, text: string): Promise<void> {
  const intent = await parseBookingIntent(env, text);
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
        `· "book saturday 2pm to 6pm"\n\n` +
        `<b>Relative days</b>\n` +
        `· today / tomorrow / this &lt;weekday&gt; / next &lt;weekday&gt;`,
    );
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

  await sendMessage(
    env,
    message.chat.id,
    `\u{1F4C5} Book the car?\n<b>${fmt(intent.startsAt)} – ${fmt(intent.endsAt)}</b>`,
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
    await answerCallbackQuery(env, cb.id, "Cancelled.");
    await sendMessage(env, chatId, "Booking cancelled.");
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
