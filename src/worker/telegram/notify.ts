import type { Env } from "../env";
import type { Booking, CarStatus } from "@/shared/types";
import { sendMessage, escapeHtml } from "./api";
import { getAllUsers } from "../core/users";
import { getCarStatus } from "../core/car";

const TIME_ZONE = "Asia/Singapore"; // family's home timezone, used for bot messages

export function formatTime(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(unixSeconds * 1000));
}

export function formatRange(booking: Pick<Booking, "startsAt" | "endsAt">): string {
  const dateTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TIME_ZONE, dateStyle: "short" });
  const start = new Date(booking.startsAt * 1000);
  // The last second of a booking decides its end day, so one ending at 00:00 stays on the day it started.
  const sameDay = day.format(start) === day.format(new Date((booking.endsAt - 1) * 1000));
  const end = new Date(booking.endsAt * 1000);
  return `${dateTime.format(start)}–${sameDay ? time.format(end) : dateTime.format(end)}`;
}

export function formatAgo(unixSeconds: number): string {
  const minutes = Math.max(0, Math.floor(Date.now() / 1000 - unixSeconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function statusLine(status: CarStatus | null, next: Booking | null): string {
  const location = status
    ? `\u{1F4CD} <b>${escapeHtml(status.level)}</b> · left by ${escapeHtml(status.updatedBy)}, ${formatAgo(status.updatedAt)}`
    : "\u{1F4CD} Location unknown — send me the level (e.g. <b>4B</b>)";
  if (!next) return `${location}\nNo upcoming bookings — car is free.`;
  const now = Math.floor(Date.now() / 1000);
  const usage =
    next.startsAt <= now
      ? `\u{1F697} In use by <b>${escapeHtml(next.userName)}</b> until ${formatTime(next.endsAt)}`
      : `Free until <b>${formatTime(next.startsAt)}</b> (${escapeHtml(next.userName)})`;
  return `${location}\n${usage}`;
}

async function notify(env: Env, chatId: string | number, html: string): Promise<void> {
  try {
    await sendMessage(env, String(chatId), html);
  } catch (err) {
    console.error("notification failed", err);
  }
}

async function notifyOthers(env: Env, actorId: number, html: string): Promise<void> {
  const users = await getAllUsers(env);
  const others = users.filter((u) => u.telegramId !== actorId);
  await Promise.all(others.map((u) => notify(env, u.telegramId, html)));
}

export async function notifyLocation(env: Env, level: string, byName: string, actorId: number): Promise<void> {
  await notifyOthers(env, actorId, `\u{1F4CD} <b>${escapeHtml(byName)}</b> parked at <b>${escapeHtml(level)}</b>`);
}

export async function notifyBooked(env: Env, booking: Booking): Promise<void> {
  await notify(env, booking.userId, `\u{1F4C5} Booked · ${formatRange(booking)}`);
  await notifyOthers(env, booking.userId, `\u{1F4C5} <b>${escapeHtml(booking.userName)}</b> booked the car · ${formatRange(booking)}`);
}

export async function notifyCancelled(env: Env, booking: Booking): Promise<void> {
  await notify(env, booking.userId, `❌ Cancelled · ${formatRange(booking)}`);
  await notifyOthers(env, booking.userId, `❌ <b>${escapeHtml(booking.userName)}</b> cancelled · ${formatRange(booking)}`);
}

export async function notifyReminder(env: Env, booking: Booking): Promise<void> {
  const status = await getCarStatus(env);
  const where = status ? ` · car is at <b>${escapeHtml(status.level)}</b>` : "";
  await notify(env, booking.userId, `⏰ Your booking starts at ${formatTime(booking.startsAt)}${where}`);
}
