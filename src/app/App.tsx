import { useCallback, useEffect, useState } from "react";
import type { Booking, CarStatus, Me } from "@/shared/types";
import { api, ApiRequestError } from "./lib/api";
import { addDays, startOfDay, toUnix } from "./lib/time";
import StatusCard from "./components/StatusCard";
import Schedule from "./components/Schedule";
import AccessDenied from "./components/AccessDenied";

const DAYS_VISIBLE = 7;

type Gate = "loading" | "denied" | "ready";

export default function App() {
  const [gate, setGate] = useState<Gate>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<CarStatus | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);

  const rangeFrom = toUnix(startOfDay(new Date()));
  const rangeTo = toUnix(addDays(startOfDay(new Date()), DAYS_VISIBLE));

  const refresh = useCallback(async () => {
    const [statusResult, bookingsResult] = await Promise.all([
      api.status(),
      api.bookings(rangeFrom, rangeTo),
    ]);
    setStatus(statusResult);
    setBookings(bookingsResult);
  }, [rangeFrom, rangeTo]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await api.me();
        if (cancelled) return;
        setMe(user);
        await refresh();
        if (!cancelled) setGate("ready");
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiRequestError && (err.status === 401 || err.status === 403)) {
          setGate("denied");
        } else {
          console.error(err);
          setGate("denied");
        }
      }
    })();

    const onFocus = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  if (gate === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="font-sign text-sm font-semibold tracking-[0.3em] text-hint pulse-soft">
          TELECAR
        </div>
      </div>
    );
  }

  if (gate === "denied" || !me) return <AccessDenied />;

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col gap-5 px-4 pb-28 pt-5">
      <StatusCard status={status} onSaved={(s) => setStatus(s)} />
      <Schedule me={me} bookings={bookings} daysVisible={DAYS_VISIBLE} onChanged={refresh} />
    </div>
  );
}
