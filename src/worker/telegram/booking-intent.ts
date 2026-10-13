import type { Env } from "../env";

export interface BookingIntent {
  startsAt: number;
  endsAt: number;
}

const BOOKING_RE = /\b(book|reserve|schedule|booking|need the car|taking the car|using the car)\b/i;

export function looksLikeBooking(text: string): boolean {
  return BOOKING_RE.test(text);
}

const CANCEL_RE = /\b(cancel|unbook|delete|remove)\b/i;

export function looksLikeCancel(text: string): boolean {
  return CANCEL_RE.test(text);
}

// Anything that names a day: relative words, weekdays, month names, or digits (dates/times).
const DATE_HINT_RE = new RegExp(
  "\\b(today|tonight|tomorrow|tmr|tmrw|morning|afternoon|evening|weekend|" +
    "mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|" +
    "jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\\b|\\d",
  "i",
);

export function mentionsDate(text: string): boolean {
  return DATE_HINT_RE.test(text);
}

/**
 * Splits "Cancel my Wednesday booking. Book tonight instead" into separate requests.
 * Only splits on sentence punctuation followed by whitespace, so "2.30pm" stays intact.
 */
export function splitRequests(text: string): string[] {
  return text
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Returns unix timestamp for a given time on a given SGT calendar date.
function sgUnix(year: number, month: number, day: number, hour: number, minute = 0): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

interface CalDay {
  label: string; // "Thu Jun 12"
  y: number;
  m: number;
  d: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function buildCalendar(days = 22): CalDay[] {
  const fmt = new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const now = Date.now();
  const entries: CalDay[] = [];
  for (let i = 0; i < days; i++) {
    const parts = fmt
      .formatToParts(new Date(now + i * 86_400_000))
      .reduce<Record<string, string>>((acc, p) => { acc[p.type] = p.value; return acc; }, {});
    const y = Number(parts.year);
    const m = Number(parts.month);
    const d = Number(parts.day);
    entries.push({ label: `${parts.weekday} ${MONTHS[m - 1]} ${d}`, y, m, d });
  }
  return entries;
}

const PART_HOURS: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 23],
  night: [18, 23],
};

// The model only picks day indexes and a part-of-day / clock hours; all
// timestamps are computed here. Small models reliably select indexes but
// hallucinate digits when asked to emit unix timestamps directly.
export async function parseBookingIntent(env: Env, text: string): Promise<BookingIntent | null> {
  const entries = buildCalendar();
  const dayList = entries.map((e, i) => `${i}:${e.label}`).join(" ");

  const systemPrompt =
    `You extract the day and time of a car booking (or booking cancellation) request. Today is ${entries[0].label} (Asia/Singapore). ` +
    `Numbered days: ${dayList} ` +
    `Reply with ONLY raw JSON, no markdown, no explanation: ` +
    `{"startDay":<index>,"endDay":<index>,"part":<"whole"|"morning"|"afternoon"|"evening"|null>,"startHour":<0-23 or null>,"endHour":<0-23 or null>} ` +
    `Rules: ` +
    `"today" = startDay 0. "tomorrow" = startDay 1. ` +
    `The week runs Monday to Sunday (Singapore), so Sunday is the last day of the week. ` +
    `A bare weekday or "this <weekday>" = the first day labelled with that weekday in the list (this week's). ` +
    `"next <weekday>" = the second day labelled with that weekday. ` +
    `Single day: endDay = startDay. Date range like "21-23 june": startDay = first date, endDay = last date. ` +
    `No time of day mentioned, or "whole day"/"all day": part = "whole". ` +
    `"morning"/"afternoon"/"evening"/"tonight": set part, hours null. ` +
    `Clock times like "2pm to 6pm": startHour 14, endHour 18, part null. Half hours allowed, e.g. 14.5 for 2:30pm. ` +
    `If you cannot determine the day, reply: {"error":"unclear"}`;

  try {
    const result = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 80,
    })) as { response?: unknown };

    // Newer Workers AI models return `response` already parsed as an object;
    // older ones returned a JSON string. Handle both.
    const resp = result.response;
    let parsed: Record<string, unknown>;
    if (resp && typeof resp === "object") {
      parsed = resp as Record<string, unknown>;
    } else {
      const match = (typeof resp === "string" ? resp : "").match(/\{[\s\S]*?\}/);
      if (!match) return null;
      parsed = JSON.parse(match[0]) as Record<string, unknown>;
    }
    if (parsed.error) return null;

    const idx = (v: unknown): number | null =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 && v < entries.length ? v : null;
    const si = idx(parsed.startDay);
    if (si === null) return null;
    const ei = Math.max(si, idx(parsed.endDay) ?? si);
    const start = entries[si];
    const end = entries[ei];

    const hour = (v: unknown): number | null =>
      typeof v === "number" && v >= 0 && v < 24 ? v : null;
    const sh = hour(parsed.startHour);
    const eh = hour(parsed.endHour);

    let startsAt: number;
    let endsAt: number;
    if (sh !== null && eh !== null) {
      startsAt = sgUnix(start.y, start.m, start.d, Math.floor(sh), Math.round((sh % 1) * 60));
      endsAt = sgUnix(end.y, end.m, end.d, Math.floor(eh), Math.round((eh % 1) * 60));
      if (endsAt <= startsAt) endsAt += 86_400; // e.g. "10pm to 1am" crosses midnight
    } else {
      const part = typeof parsed.part === "string" ? PART_HOURS[parsed.part.toLowerCase()] : undefined;
      if (part) {
        startsAt = sgUnix(start.y, start.m, start.d, part[0]);
        endsAt = sgUnix(end.y, end.m, end.d, part[1]);
      } else {
        startsAt = sgUnix(start.y, start.m, start.d, 0);
        endsAt = sgUnix(end.y, end.m, end.d, 23, 59) + 59;
      }
    }

    if (endsAt <= startsAt) return null;
    if (endsAt < Math.floor(Date.now() / 1000)) return null;
    return { startsAt, endsAt };
  } catch {
    return null;
  }
}
