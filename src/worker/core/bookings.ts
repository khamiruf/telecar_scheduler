import type { Env } from "../env";
import type { Booking } from "@/shared/types";

interface BookingRow {
  id: number;
  user_id: number;
  starts_at: number;
  ends_at: number;
  first_name: string | null;
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.first_name ?? "someone",
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

export async function listBookings(env: Env, from: number, to: number): Promise<Booking[]> {
  const { results } = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id " +
      "WHERE b.starts_at < ?2 AND b.ends_at > ?1 ORDER BY b.starts_at",
  )
    .bind(from, to)
    .all<BookingRow>();
  return results.map(toBooking);
}

export type CreateResult =
  | { ok: true; booking: Booking }
  | { ok: false; reason: "overlap" | "past" | "invalid" };

export async function createBooking(
  env: Env,
  userId: number,
  startsAt: number,
  endsAt: number,
): Promise<CreateResult> {
  if (!Number.isInteger(startsAt) || !Number.isInteger(endsAt) || endsAt <= startsAt) {
    return { ok: false, reason: "invalid" };
  }
  if (endsAt < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: "past" };
  }
  // Conditional insert keeps the overlap check and the write in one statement,
  // so two simultaneous bookings can't both slip through.
  const result = await env.DB.prepare(
    "INSERT INTO bookings (user_id, starts_at, ends_at) " +
      "SELECT ?1, ?2, ?3 WHERE NOT EXISTS " +
      "(SELECT 1 FROM bookings WHERE starts_at < ?3 AND ends_at > ?2)",
  )
    .bind(userId, startsAt, endsAt)
    .run();
  if (result.meta.changes === 0) {
    return { ok: false, reason: "overlap" };
  }
  const booking = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id WHERE b.id = ?",
  )
    .bind(result.meta.last_row_id)
    .first<BookingRow>();
  return { ok: true, booking: toBooking(booking!) };
}

/** Deletes only if the booking belongs to the user. Returns the deleted booking, or null. */
export async function cancelBooking(
  env: Env,
  bookingId: number,
  userId: number,
): Promise<Booking | null> {
  const row = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id WHERE b.id = ?1 AND b.user_id = ?2",
  )
    .bind(bookingId, userId)
    .first<BookingRow>();
  if (!row) return null;
  const result = await env.DB.prepare("DELETE FROM bookings WHERE id = ?1 AND user_id = ?2")
    .bind(bookingId, userId)
    .run();
  // A concurrent cancel (e.g. a double-tapped button) may have deleted it after our SELECT.
  if (result.meta.changes === 0) return null;
  return toBooking(row);
}

/** Next booking starting after `now`, or the one currently in progress. */
export async function currentOrNextBooking(env: Env, now: number): Promise<Booking | null> {
  const row = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id " +
      "WHERE b.ends_at > ? ORDER BY b.starts_at LIMIT 1",
  )
    .bind(now)
    .first<BookingRow>();
  return row ? toBooking(row) : null;
}

/** Bookings starting within the next `windowSeconds` that haven't been reminded yet. */
export async function dueReminders(env: Env, windowSeconds: number): Promise<Booking[]> {
  const { results } = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id " +
      "WHERE b.reminder_sent = 0 AND b.starts_at > unixepoch() " +
      "AND b.starts_at <= unixepoch() + ?",
  )
    .bind(windowSeconds)
    .all<BookingRow>();
  return results.map(toBooking);
}

export async function markReminded(env: Env, bookingIds: number[]): Promise<void> {
  if (bookingIds.length === 0) return;
  const placeholders = bookingIds.map(() => "?").join(",");
  await env.DB.prepare(`UPDATE bookings SET reminder_sent = 1 WHERE id IN (${placeholders})`)
    .bind(...bookingIds)
    .run();
}

/** The user's own bookings that haven't ended yet (includes one in progress), soonest first. */
export async function upcomingBookingsForUser(env: Env, userId: number, now: number): Promise<Booking[]> {
  const { results } = await env.DB.prepare(
    "SELECT b.id, b.user_id, b.starts_at, b.ends_at, u.first_name FROM bookings b " +
      "LEFT JOIN users u ON u.telegram_id = b.user_id " +
      "WHERE b.user_id = ?1 AND b.ends_at > ?2 ORDER BY b.starts_at",
  )
    .bind(userId, now)
    .all<BookingRow>();
  return results.map(toBooking);
}
