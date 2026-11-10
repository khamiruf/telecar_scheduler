import type { Env } from "../env";

export interface TimeRange {
  startsAt: number;
  endsAt: number;
}

/**
 * One request extracted from a message. A message can carry several, e.g.
 * "Cancel my Wednesday booking. Book tonight instead" → [cancel Wed, book tonight].
 * `range: null` on a booking means the model couldn't pin down the time; `tooFar` means the
 * date was past the last day the bot can book (see BOOKING_HORIZON_DAYS).
 * On a cancel, "soonest" means no day was given; "unclear" means a day was given but unusable.
 * "list" asks for upcoming bookings; "calendar" asks to open the schedule Mini App.
 * "check" asks whether the car is free (range null = couldn't pin down the time);
 * "where" asks where the car is; "location" reports where it was parked.
 */
export type CarRequest =
  | { type: "book"; range: TimeRange | null; tooFar?: boolean }
  | { type: "cancel"; when: TimeRange | "soonest" | "unclear" }
  | { type: "list"; whose: "mine" | "everyone" }
  | { type: "calendar" }
  | { type: "check"; range: TimeRange | null }
  | { type: "where" }
  | { type: "location" }
  | { type: "help" }
  | { type: "thanks" };

const BOOKING_RE = /\b(book|reserve|schedule|booking|need the car|taking the car|using the car)\b/i;

export function looksLikeBooking(text: string): boolean {
  return BOOKING_RE.test(text);
}

const CANCEL_RE = /\b(cancel|unbook|delete|remove)\b/i;

export function looksLikeCancel(text: string): boolean {
  return CANCEL_RE.test(text);
}

// "app"/"menu" only count after open/show/see, so "parked at 4B, update the app" stays a location update.
const VIEW_RE = /\b(bookings|reservations|upcoming|calendar|schedule)\b|\b(open|show|see)\b.{0,20}\b(app|menu)\b/i;

/** "Find my upcoming bookings", "show me the calendar", "open the app". */
export function looksLikeView(text: string): boolean {
  return VIEW_RE.test(text);
}

const QUESTION_RE = /\?|\b(where|which|who|when|free|available|anyone|help)\b/i;

/**
 * Whether a message that contains a parking level might be asking for something else
 * ("is the car at 4B?", "book 4B... "), in which case the model should read it.
 */
export function mightBeRequest(text: string): boolean {
  return looksLikeBooking(text) || looksLikeCancel(text) || looksLikeView(text) || QUESTION_RE.test(text);
}

function sgClock(): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Singapore",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

// Returns unix timestamp for a given time on a given SGT calendar date.
function sgUnix(year: number, month: number, day: number, hour: number, minute = 0): number {
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`;
  return Math.floor(new Date(iso).getTime() / 1000);
}

interface CalDay {
  label: string; // "Thu 2026-06-12"
  y: number;
  m: number;
  d: number;
}

/** How far ahead (in days from today) people can book. */
export const BOOKING_HORIZON_DAYS = 120;

const pad2 = (n: number) => String(n).padStart(2, "0");
const isoDate = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * The next two weeks, so the model can turn "saturday" / "next friday" into a date by copying it
 * from the list. Specific dates ("6 dec") it writes out itself; nothing relies on it counting.
 */
function buildCalendar(days = 15): CalDay[] {
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
    entries.push({ label: `${parts.weekday} ${isoDate(y, m, d)}`, y, m, d });
  }
  return entries;
}

const PART_HOURS: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 18],
  evening: [18, 23],
  night: [18, 23],
};

/** Where a booking given only a start time ends: the end of the part of day it starts in. */
function endOfPartHour(startHour: number): [number, number] {
  if (startHour < 12) return [12, 0];
  if (startHour < 18) return [18, 0];
  if (startHour < 23) return [23, 0];
  return [23, 59];
}

// The model only writes calendar dates (YYYY-MM-DD) and a part-of-day / clock hours; all
// timestamps are computed here. Small models hallucinate digits when asked to emit unix
// timestamps, and miscount when asked to pick a position in a long list of days.
export async function parseCarRequests(env: Env, text: string): Promise<CarRequest[] | null> {
  const entries = buildCalendar();
  const dayList = entries.map((e) => e.label).join(", ");

  const systemPrompt =
    `You read messages sent to a family's shared-car Telegram bot and extract what the sender wants. ` +
    `Today is ${entries[0].label} and the time is ${sgClock()} (Asia/Singapore). ` +
    `The next two weeks: ${dayList}. ` +
    `Reply with ONLY raw JSON, no markdown, no explanation: ` +
    `{"actions":[{"type":<"book"|"cancel"|"list"|"calendar"|"check"|"where"|"location"|"help"|"thanks">,"whose":<"mine"|"everyone"|null>,"startDate":<"YYYY-MM-DD" or null>,"endDate":<"YYYY-MM-DD" or null>,"part":<"whole"|"morning"|"afternoon"|"evening"|null>,"startHour":<0-23 or null>,"endHour":<0-23 or null>}, ...]} ` +
    `Rules: ` +
    `One action per request, in the order mentioned. A message can hold several, e.g. ` +
    `"cancel wednesday, book tonight instead" or "move my booking from friday to saturday" = a cancel then a book. ` +
    `"cancel"/"unbook"/"delete"/"remove" = type "cancel". For a cancel with no day mentioned, startDate = null. ` +
    `Asking to see or find bookings ("my upcoming bookings", "what have I booked", "who has the car this week") = type "list", ` +
    `with whose "mine" for the sender's own bookings and "everyone" for all bookings; date fields null. ` +
    `Asking to open or show the calendar, schedule, app or menu = type "calendar", other fields null. ` +
    `"schedule" as a verb ("schedule the car for friday") is a booking, not "calendar". ` +
    `Asking whether the car is free or if anyone is using it at some time ("is the car free tomorrow evening?", ` +
    `"anyone using the car tonight?", "when is the car free on saturday?") = type "check" with the day/time fields; ` +
    `if no day is given, startDate null. "can I take the car later?" is a check, not a booking. ` +
    `Asking where the car is now, which level it is on, or who has it right now = type "where", other fields null. ` +
    `Saying where the car was parked ("parked at B2", "car is on level 4") = type "location", other fields null. ` +
    `Greetings, "help", or "what can you do" = type "help". "thanks", "ok", "noted" and similar = type "thanks". ` +
    `Messages may be in English, Singlish or Malay: "tmr"/"tmrw"/"esok" = tomorrow, "tonite"/"malam ni" = tonight, ` +
    `"pagi" = morning, "petang" = afternoon, "tempah" = book, "batal" = cancel, "kereta" = car. ` +
    `"now"/"right now" = today's date and startHour = the current time, rounded down to the half hour. ` +
    `A duration like "3pm for 2 hours" = startHour 15, endHour 17. ` +
    `"this weekend" = this week's Saturday to Sunday; "next weekend" = the following Saturday to Sunday. ` +
    `"today" = ${isoDate(entries[0].y, entries[0].m, entries[0].d)}. "tomorrow" = ${isoDate(entries[1].y, entries[1].m, entries[1].d)}. ` +
    `The week runs Monday to Sunday (Singapore), so Sunday is the last day of the week. ` +
    `A bare weekday or "this <weekday>" = the first day labelled with that weekday in the list (this week's). ` +
    `"next <weekday>" = the second day labelled with that weekday. ` +
    `A specific date like "6 dec" or "21 june" = write that date out, in the current year unless it has already passed, ` +
    `in which case next year; it does not need to be in the list. ` +
    `Single day: endDate = startDate. Date range like "21-23 june": startDate = first date, endDate = last date. ` +
    `No time of day mentioned, or "whole day"/"all day": part = "whole". ` +
    `"morning"/"afternoon"/"evening"/"tonight" with no clock time: set part, hours null. ` +
    `Clock times like "2pm to 6pm": startHour 14, endHour 18, part null. Half hours allowed, e.g. 14.5 for 2:30pm. ` +
    `A single clock time like "tonight 7pm" or "at 2pm": startHour 19 (or 14), endHour null. ` +
    `A clock time always wins over "morning"/"afternoon"/"evening"/"tonight", so never drop it. ` +
    `If you cannot make sense of the message at all, reply: {"error":"unclear"}`;

  try {
    const result = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast" as Parameters<Ai["run"]>[0], {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ],
      max_tokens: 300,
    })) as { response?: unknown };

    // Newer Workers AI models return `response` already parsed as an object;
    // older ones returned a JSON string. Handle both.
    const resp = result.response;
    let parsed: Record<string, unknown>;
    if (resp && typeof resp === "object") {
      parsed = resp as Record<string, unknown>;
    } else {
      const str = typeof resp === "string" ? resp : "";
      const start = str.indexOf("{");
      const end = str.lastIndexOf("}");
      if (start < 0 || end <= start) return null;
      parsed = JSON.parse(str.slice(start, end + 1)) as Record<string, unknown>;
    }
    if (parsed.error || !Array.isArray(parsed.actions)) return null;

    const requests: CarRequest[] = [];
    const mentioned = mentionedDates(text);
    for (const raw of parsed.actions as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const action = correctDates(entries[0], raw as Record<string, unknown>, mentioned);
      if (action.type === "cancel") {
        if (action.startDate === null || action.startDate === undefined) {
          requests.push({ type: "cancel", when: "soonest" });
        } else {
          requests.push({ type: "cancel", when: resolveRange(entries, action) ?? "unclear" });
        }
      } else if (action.type === "check") {
        // No day means today; the handler only looks from now onwards.
        const today = isoDate(entries[0].y, entries[0].m, entries[0].d);
        const withDay = action.startDate === null || action.startDate === undefined ? { ...action, startDate: today } : action;
        requests.push({ type: "check", range: resolveRange(entries, withDay) });
      } else if (action.type === "where" || action.type === "location" || action.type === "help" || action.type === "thanks") {
        requests.push({ type: action.type });
      } else if (action.type === "list") {
        requests.push({ type: "list", whose: action.whose === "everyone" ? "everyone" : "mine" });
      } else if (action.type === "calendar") {
        requests.push({ type: "calendar" });
      } else if (action.type === "book") {
        const start = parseDate(entries[0], action.startDate);
        if (start !== null && start.offset >= BOOKING_HORIZON_DAYS) {
          requests.push({ type: "book", range: null, tooFar: true });
          continue;
        }
        const range = resolveRange(entries, action);
        const future = range && range.endsAt >= Math.floor(Date.now() / 1000) ? range : null;
        requests.push({ type: "book", range: future });
      }
    }
    return requests.length > 0 ? requests : null;
  } catch {
    return null;
  }
}

interface Day {
  y: number;
  m: number;
  d: number;
}

// English and Malay month names, by month number.
const MONTH_WORDS: [RegExp, number][] = [
  [/^(jan|january|januari)$/, 1],
  [/^(feb|february|februari)$/, 2],
  [/^(mar|march|mac)$/, 3],
  [/^(apr|april)$/, 4],
  [/^(may|mei)$/, 5],
  [/^(jun|june)$/, 6],
  [/^(jul|july|julai)$/, 7],
  [/^(aug|august|ogos)$/, 8],
  [/^(sep|sept|september)$/, 9],
  [/^(oct|october|oktober)$/, 10],
  [/^(nov|november)$/, 11],
  [/^(dec|december|disember)$/, 12],
];
const MONTH = "([a-z]{3,9})";
// A day of the month, but not the hour in "3pm", "3-8pm", "3 to 8pm" or "3:30".
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?(?!\\s*(?:am|pm|[:.]\\d)|\\s*(?:-|to)\\s*\\d{1,2}\\s*(?:am|pm|[:.]\\d))";
const SPAN = "(?:\\s*(?:-|to|until|till)\\s*";
// "6 dec", "21-23 june", "6th of december" / "dec 6", "december 21-23".
const DAY_MONTH_RE = new RegExp(`\\b${DAY}${SPAN}${DAY})?\\s*(?:of\\s+)?${MONTH}\\b`, "gi");
const MONTH_DAY_RE = new RegExp(`\\b${MONTH}\\s+${DAY}${SPAN}${DAY})?\\b`, "gi");

function monthNumber(word: string): number | null {
  const w = word.toLowerCase();
  for (const [re, n] of MONTH_WORDS) if (re.test(w)) return n;
  return null;
}

/**
 * Dates written out with a month name in the message ("6 Dec", "21-23 june", "Dec 6th"), in the
 * order written. Each mention is a list of "MM-DD": one for a single date, two for a range.
 */
export function mentionedDates(text: string): string[][] {
  const found: { from: number; to: number; dates: string[] }[] = [];
  const add = (match: RegExpMatchArray, month: string, ...days: (string | undefined)[]) => {
    const m = monthNumber(month);
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (m === null || found.some((f) => from < f.to && to > f.from)) return; // not a month, or overlaps one found
    const dates = days.filter((d): d is string => d !== undefined).map((d) => `${pad2(m)}-${pad2(Number(d))}`);
    found.push({ from, to, dates });
  };
  for (const match of text.matchAll(DAY_MONTH_RE)) add(match, match[3], match[1], match[2]);
  for (const match of text.matchAll(MONTH_DAY_RE)) add(match, match[1], match[2], match[3]);
  return found.sort((a, b) => a.from - b.from).map((f) => f.dates);
}

/**
 * When the message spells out exactly one date or range ("6 Dec", "21-23 june") and the model
 * gave a different day, use the spelled-out one: the model sometimes picks the wrong day.
 * Also fills in the date when the model left it out. With several dates ("move it from 6 dec to
 * 8 dec") it's left to the model.
 */
function correctDates(today: Day, action: Record<string, unknown>, mentioned: string[][]): Record<string, unknown> {
  // Only these carry a date. One the model left without a date still gets the spelled-out one.
  if (mentioned.length !== 1 || !["book", "cancel", "check"].includes(action.type as string)) return action;
  const [first, last = first] = mentioned[0];
  if (parseDate(today, first) === null || parseDate(today, last) === null) return action; // e.g. "31 nov"
  const monthDay = (v: unknown) => {
    const p = parseDate(today, v);
    return p === null ? null : `${pad2(p.m)}-${pad2(p.d)}`;
  };
  const end = action.endDate === null || action.endDate === undefined ? action.startDate : action.endDate;
  if (monthDay(action.startDate) === first && monthDay(end) === last) return action;
  return { ...action, startDate: first, endDate: last };
}

/**
 * A "YYYY-MM-DD" date and how many days it is from `today`, or null if it isn't a real date. A date
 * more than a week in the past is taken as next year's ("5 jan" said in November), in case the
 * model got the year wrong.
 */
function parseDate(today: Day, value: unknown): (Day & { offset: number }) | null {
  if (typeof value !== "string") return null;
  // "2026-12-06", also tolerating a trailing time ("2026-12-06T15:00") or a missing year ("12-06").
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(value.trim());
  const short = full ? null : /^(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!full && !short) return null;
  let y = full ? Number(full[1]) : today.y;
  const m = Number(full ? full[2] : short![1]);
  const d = Number(full ? full[3] : short![2]);
  const base = Date.UTC(today.y, today.m - 1, today.d);
  const at = (year: number) => {
    const t = new Date(Date.UTC(year, m - 1, d));
    // Reject dates like 31 Nov that Date would roll over into December.
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? Math.round((t.getTime() - base) / 86_400_000) : null;
  };
  let offset = at(y);
  if (offset === null) return null;
  if (offset < -7) {
    const next = at(y + 1);
    if (next === null) return null;
    y += 1;
    offset = next;
  }
  return { y, m, d, offset };
}

function resolveRange(entries: CalDay[], action: Record<string, unknown>): TimeRange | null {
  const start = parseDate(entries[0], action.startDate);
  if (start === null) return null;
  const parsedEnd = parseDate(entries[0], action.endDate);
  const end = parsedEnd !== null && parsedEnd.offset >= start.offset ? parsedEnd : start;

  const hour = (v: unknown): number | null =>
    typeof v === "number" && v >= 0 && v < 24 ? v : null;
  const sh = hour(action.startHour);
  const eh = hour(action.endHour);

  let startsAt: number;
  let endsAt: number;
  if (sh !== null) {
    startsAt = sgUnix(start.y, start.m, start.d, Math.floor(sh), Math.round((sh % 1) * 60));
    if (eh !== null) {
      endsAt = sgUnix(end.y, end.m, end.d, Math.floor(eh), Math.round((eh % 1) * 60));
      if (endsAt <= startsAt) endsAt += 86_400; // e.g. "10pm to 1am" crosses midnight
    } else {
      // Only a start time, e.g. "tonight 7pm": run to the end of that part of the day.
      const [h, m] = endOfPartHour(sh);
      endsAt = sgUnix(end.y, end.m, end.d, h, m) + (h === 23 && m === 59 ? 59 : 0);
    }
  } else {
    const part = typeof action.part === "string" ? PART_HOURS[action.part.toLowerCase()] : undefined;
    if (part) {
      startsAt = sgUnix(start.y, start.m, start.d, part[0]);
      endsAt = sgUnix(end.y, end.m, end.d, part[1]);
    } else {
      startsAt = sgUnix(start.y, start.m, start.d, 0);
      endsAt = sgUnix(end.y, end.m, end.d, 23, 59) + 59;
    }
  }
  return endsAt > startsAt ? { startsAt, endsAt } : null;
}
