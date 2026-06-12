import type { Booking, CarStatus, Me } from "@/shared/types";
import { tg } from "./telegram";

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `tma ${tg.initData}`,
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let code = "request_failed";
    try {
      code = ((await res.json()) as { error?: string }).error ?? code;
    } catch {
      // non-JSON error body — keep the generic code
    }
    throw new ApiRequestError(res.status, code);
  }
  return res.json() as Promise<T>;
}

export const api = {
  me: () => request<Me>("/me"),
  status: () => request<CarStatus | null>("/status"),
  setLocation: (level: string) =>
    request<CarStatus>("/status", { method: "PUT", body: JSON.stringify({ level }) }),
  bookings: (from: number, to: number) => request<Booking[]>(`/bookings?from=${from}&to=${to}`),
  book: (startsAt: number, endsAt: number) =>
    request<Booking>("/bookings", { method: "POST", body: JSON.stringify({ startsAt, endsAt }) }),
  cancel: (id: number) => request<{ ok: true }>(`/bookings/${id}`, { method: "DELETE" }),
};
