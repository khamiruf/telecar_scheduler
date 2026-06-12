import { useEffect, useMemo, useState } from "react";
import type { Booking, Me } from "@/shared/types";
import { api } from "../lib/api";
import { haptic, insideTelegram, setMainButton } from "../lib/telegram";
import { addDays, dayName, hourLabel, isSameDay, startOfDay, timeLabel, toUnix } from "../lib/time";

interface Props {
  me: Me;
  bookings: Booking[];
  daysVisible: number;
  onChanged: () => Promise<void>;
}

type Selection =
  | { kind: "range"; startHour: number; endHour: number } // [startHour, endHour] inclusive
  | { kind: "booking"; booking: Booking }
  | null;

const DAY_START = 6;
const DAY_END = 23; // last bookable hour starts at 23:00

export default function Schedule({ me, bookings, daysVisible, onChanged }: Props) {
  const today = startOfDay(new Date());
  const days = useMemo(
    () => Array.from({ length: daysVisible }, (_, i) => addDays(today, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [daysVisible, today.getTime()],
  );
  const [dayIndex, setDayIndex] = useState(0);
  const [selection, setSelection] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);

  const day = days[dayIndex];
  const dayStartUnix = toUnix(day);
  const nowUnix = Math.floor(Date.now() / 1000);

  const dayBookings = useMemo(
    () =>
      bookings.filter(
        (b) => b.startsAt < dayStartUnix + 86400 && b.endsAt > dayStartUnix,
      ),
    [bookings, dayStartUnix],
  );

  // Expand the visible window if a booking falls outside working hours.
  const firstHour = Math.min(
    DAY_START,
    ...dayBookings.map((b) => Math.max(0, Math.floor((b.startsAt - dayStartUnix) / 3600))),
  );
  const lastHour = Math.max(
    DAY_END,
    ...dayBookings.map((b) => Math.min(23, Math.ceil((b.endsAt - dayStartUnix) / 3600) - 1)),
  );
  const hours = Array.from({ length: lastHour - firstHour + 1 }, (_, i) => firstHour + i);

  const bookingAt = (hour: number): Booking | undefined => {
    const slotStart = dayStartUnix + hour * 3600;
    return dayBookings.find((b) => b.startsAt < slotStart + 3600 && b.endsAt > slotStart);
  };

  const isPast = (hour: number) => dayStartUnix + (hour + 1) * 3600 <= nowUnix;

  const clear = () => setSelection(null);

  const tapFree = (hour: number) => {
    haptic("light");
    setSelection((prev) => {
      if (prev?.kind !== "range") return { kind: "range", startHour: hour, endHour: hour };
      const { startHour, endHour } = prev;
      const lo = Math.min(startHour, hour);
      const hi = Math.max(endHour, hour);
      // Extend only across a clean free run; otherwise restart from the tapped hour.
      for (let h = lo; h <= hi; h++) {
        if (bookingAt(h) || isPast(h)) return { kind: "range", startHour: hour, endHour: hour };
      }
      if (hour >= startHour && hour <= endHour) return null; // tap inside selection clears it
      return { kind: "range", startHour: lo, endHour: hi };
    });
  };

  const tapBooking = (booking: Booking) => {
    haptic("light");
    if (booking.userId !== me.id) return;
    setSelection((prev) =>
      prev?.kind === "booking" && prev.booking.id === booking.id
        ? null
        : { kind: "booking", booking },
    );
  };

  const confirm = async () => {
    if (!selection || busy) return;
    setBusy(true);
    try {
      if (selection.kind === "range") {
        await api.book(
          dayStartUnix + selection.startHour * 3600,
          dayStartUnix + (selection.endHour + 1) * 3600,
        );
      } else {
        await api.cancel(selection.booking.id);
      }
      haptic("success");
      clear();
      await onChanged();
    } catch {
      haptic("error");
      clear();
      await onChanged(); // someone may have grabbed the slot — show fresh truth
    } finally {
      setBusy(false);
    }
  };

  const actionLabel =
    selection?.kind === "range"
      ? `Book ${dayName(day)} ${hourLabel(selection.startHour)}–${hourLabel(selection.endHour + 1)}`
      : selection?.kind === "booking"
        ? `Cancel ${timeLabel(selection.booking.startsAt)}–${timeLabel(selection.booking.endsAt)}`
        : null;

  useEffect(() => {
    setMainButton(
      actionLabel
        ? { text: actionLabel, destructive: selection?.kind === "booking", onClick: () => void confirm() }
        : null,
    );
    return () => {
      setMainButton(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionLabel]);

  return (
    <section className="rise" style={{ animationDelay: "90ms" }}>
      {/* week strip */}
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {days.map((d, i) => {
          const active = i === dayIndex;
          return (
            <button
              key={d.getTime()}
              onClick={() => {
                haptic("light");
                setDayIndex(i);
                clear();
              }}
              className={`pressable flex shrink-0 flex-col items-center rounded-xl px-3.5 py-2 font-sign ${
                active ? "bg-paint text-paint-ink" : "bg-bg2 text-hint"
              }`}
            >
              <span className="text-[10px] font-bold tracking-[0.18em]">
                {isSameDay(d, today) ? "TODAY" : dayName(d).toUpperCase()}
              </span>
              <span className={`text-lg font-black leading-tight ${active ? "" : "text-ink"}`}>
                {d.getDate()}
              </span>
            </button>
          );
        })}
      </div>

      {/* timeline */}
      <div className="mt-3 overflow-hidden rounded-2xl bg-bg2">
        {hours.map((hour) => {
          const booking = bookingAt(hour);
          const past = isPast(hour);
          const slotStart = dayStartUnix + hour * 3600;
          const isNow = nowUnix >= slotStart && nowUnix < slotStart + 3600;
          const selected =
            selection?.kind === "range" &&
            hour >= selection.startHour &&
            hour <= selection.endHour;
          const bookingSelected =
            selection?.kind === "booking" && booking?.id === selection.booking.id;
          const isBookingStart = booking && booking.startsAt >= slotStart;

          return (
            <div key={hour} className="flex items-stretch">
              <div className="w-14 shrink-0 py-2 pl-4 pr-2 text-right font-sign text-[11px] font-semibold tabular-nums text-hint">
                {hourLabel(hour)}
              </div>
              <div className="relative mr-3 min-w-0 flex-1 border-b border-bg py-1 last:border-0">
                {isNow && (
                  <div className="absolute -left-1 top-0 h-full w-0.5 rounded bg-paint" aria-hidden />
                )}
                {booking ? (
                  <button
                    onClick={() => tapBooking(booking)}
                    className={`pressable block h-9 w-full rounded-lg px-3 text-left ${
                      booking.userId === me.id
                        ? bookingSelected
                          ? "bg-destructive/90 text-white"
                          : "bg-button text-button-text"
                        : "bg-hint/15 text-hint"
                    }`}
                  >
                    {isBookingStart && (
                      <span className="font-sign text-[13px] font-bold leading-9">
                        {booking.userId === me.id ? "You" : booking.userName}
                        {bookingSelected && " — cancel?"}
                      </span>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={() => !past && tapFree(hour)}
                    disabled={past}
                    className={`pressable block h-9 w-full rounded-lg px-3 text-left ${
                      selected
                        ? "bg-paint text-paint-ink"
                        : past
                          ? "opacity-30"
                          : "active:bg-paint/20"
                    }`}
                  >
                    {selected && (
                      <span className="font-sign text-[13px] font-bold leading-9">
                        {hour === selection.startHour ? "Selected" : ""}
                      </span>
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p className="mt-3 text-center text-[12px] text-hint">
        Tap a free hour to book · tap again to extend · tap your booking to cancel
      </p>

      {/* fallback action button when running outside Telegram */}
      {!insideTelegram && actionLabel && (
        <button
          onClick={() => void confirm()}
          disabled={busy}
          className={`pressable fixed inset-x-4 bottom-5 z-10 mx-auto max-w-md rounded-2xl py-4 font-sign text-base font-extrabold ${
            selection?.kind === "booking" ? "bg-destructive text-white" : "bg-paint text-paint-ink"
          }`}
        >
          {busy ? "…" : actionLabel}
        </button>
      )}
    </section>
  );
}
