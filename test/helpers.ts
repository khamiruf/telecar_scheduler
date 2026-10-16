import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import type { Env } from "@/worker/env";
import type { CarRequest } from "@/worker/telegram/booking-intent";

/** Unix seconds for a Singapore wall-clock time, e.g. sg("2026-10-14T00:00"). */
export function sg(local: string): number {
  return Math.floor(Date.parse(`${local}+08:00`) / 1000);
}

/** In-memory SQLite behind the slice of the D1 API the worker uses, with the real migrations applied. */
export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path.resolve(__dirname, "../migrations/0001_init.sql"), "utf8"));
  const d1 = {
    prepare(sql: string) {
      let params: unknown[] = [];
      const stmt = {
        bind(...p: unknown[]) {
          params = p;
          return stmt;
        },
        async first() {
          return db.prepare(sql).get(...(params as never[])) ?? null;
        },
        async all() {
          return { results: db.prepare(sql).all(...(params as never[])) };
        },
        async run() {
          const r = db.prepare(sql).run(...(params as never[]));
          return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
        },
      };
      return stmt;
    },
  };
  return { db, d1: d1 as unknown as D1Database };
}

/** A queued AI reply returned as-is instead of wrapped in `response`, e.g. a Whisper transcript. */
export function whisper(text: string) {
  return { __raw: { text } };
}

/** Workers AI stub: each call returns the next queued reply (an object, a string, or an Error to throw). */
export function fakeAI(...replies: unknown[]) {
  const run = vi.fn(async () => {
    const next = replies.shift();
    if (next instanceof Error) throw next;
    if (next && typeof next === "object" && "__raw" in next) return (next as { __raw: unknown }).__raw;
    return { response: next };
  });
  return { run } as unknown as Ai & { run: typeof run };
}

export interface SentCall {
  method: string;
  body: Record<string, any>;
}

/** Captures every Telegram Bot API call made through global fetch. */
export function captureTelegram(): SentCall[] {
  const calls: SentCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (String(url).includes("/file/bot")) return new Response(new Uint8Array([1, 2, 3])); // voice note audio
    const method = String(url).split("/").pop()!;
    calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
    const result = method === "getFile" ? { file_path: "voice/1.oga" } : {};
    return new Response(JSON.stringify({ ok: true, result }));
  });
  return calls;
}

export function makeEnv(d1: D1Database, ai: Ai): Env {
  return {
    DB: d1,
    AI: ai,
    ASSETS: {} as Fetcher,
    ADMIN_ID: "999",
    GROUP_CHAT_ID: "",
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
  };
}

/** Builds a model reply action with the defaults the prompt asks for. */
export function action(type: CarRequest["type"], fields: Record<string, unknown> = {}) {
  return { type, startDay: null, endDay: null, part: null, startHour: null, endHour: null, ...fields };
}
