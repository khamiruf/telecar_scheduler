import { Hono } from "hono";
import type { Env } from "./env";
import type { User } from "./core/users";
import { resolveAuthorizedUser } from "./core/users";
import { getCarStatus, setCarLocation } from "./core/car";
import {
  cancelBooking,
  createBooking,
  dueReminders,
  listBookings,
  markReminded,
} from "./core/bookings";
import { validateInitData } from "./telegram/auth";
import { handleUpdate } from "./telegram/webhook";
import type { TgUpdate } from "./telegram/api";
import { notifyBooked, notifyCancelled, notifyLocation, notifyReminder } from "./telegram/notify";

type AppContext = { Bindings: Env; Variables: { user: User } };

const app = new Hono<AppContext>();

// ---------------------------------------------------------------------------
// Telegram webhook
// ---------------------------------------------------------------------------

app.post("/telegram/webhook", async (c) => {
  const secret = c.req.header("x-telegram-bot-api-secret-token");
  if (secret !== c.env.TELEGRAM_WEBHOOK_SECRET) {
    return c.text("forbidden", 403);
  }
  const update = await c.req.json<TgUpdate>();
  await handleUpdate(c.env, update, new URL(c.req.url).origin);
  return c.text("ok");
});

// ---------------------------------------------------------------------------
// Mini App API — every route authenticates via Telegram initData
// ---------------------------------------------------------------------------

const api = new Hono<AppContext>();

api.use("*", async (c, next) => {
  const header = c.req.header("authorization") ?? "";
  const initData = header.startsWith("tma ") ? header.slice(4) : null;

  let id: number | null = null;
  let firstName = "";

  if (initData) {
    const tgUser = await validateInitData(initData, c.env.TELEGRAM_BOT_TOKEN);
    if (tgUser) {
      id = tgUser.id;
      firstName = tgUser.first_name;
    }
  } else if (c.env.DEV_USER_ID) {
    // Local development outside Telegram (.dev.vars only — unset in production).
    id = Number(c.env.DEV_USER_ID);
    firstName = "Dev";
  }

  if (id === null) return c.json({ error: "unauthorized" }, 401);

  const user = await resolveAuthorizedUser(c.env, id, firstName);
  if (!user) return c.json({ error: "not_whitelisted" }, 403);

  c.set("user", user);
  await next();
});

api.get("/me", (c) => {
  const user = c.get("user");
  return c.json({ id: user.telegramId, firstName: user.firstName, isAdmin: user.isAdmin });
});

api.get("/status", async (c) => {
  return c.json(await getCarStatus(c.env));
});

api.put("/status", async (c) => {
  const { level } = await c.req.json<{ level?: string }>();
  const cleaned = level?.trim().toUpperCase() ?? "";
  if (!cleaned || cleaned.length > 10) return c.json({ error: "invalid_level" }, 400);
  const user = c.get("user");
  await setCarLocation(c.env, cleaned, user.telegramId);
  c.executionCtx.waitUntil(notifyLocation(c.env, cleaned, user.firstName));
  return c.json(await getCarStatus(c.env));
});

api.get("/bookings", async (c) => {
  const from = Number(c.req.query("from"));
  const to = Number(c.req.query("to"));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return c.json({ error: "invalid_range" }, 400);
  }
  return c.json(await listBookings(c.env, from, to));
});

api.post("/bookings", async (c) => {
  const { startsAt, endsAt } = await c.req.json<{ startsAt?: number; endsAt?: number }>();
  const user = c.get("user");
  const result = await createBooking(c.env, user.telegramId, startsAt ?? NaN, endsAt ?? NaN);
  if (!result.ok) return c.json({ error: result.reason }, result.reason === "overlap" ? 409 : 400);
  c.executionCtx.waitUntil(notifyBooked(c.env, result.booking));
  return c.json(result.booking, 201);
});

api.delete("/bookings/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid_id" }, 400);
  const user = c.get("user");
  const cancelled = await cancelBooking(c.env, id, user.telegramId);
  if (!cancelled) return c.json({ error: "not_found_or_not_yours" }, 404);
  c.executionCtx.waitUntil(notifyCancelled(c.env, cancelled));
  return c.json({ ok: true });
});

app.route("/api", api);

// Static assets (the Mini App) are served by the Workers assets pipeline for
// any route not matched above.

// ---------------------------------------------------------------------------
// Cron: remind the group ~30 minutes before a booking starts
// ---------------------------------------------------------------------------

async function sendReminders(env: Env): Promise<void> {
  const due = await dueReminders(env, 30 * 60);
  if (due.length === 0) return;
  await markReminded(
    env,
    due.map((b) => b.id),
  );
  for (const booking of due) {
    await notifyReminder(env, booking);
  }
}

export default {
  fetch: app.fetch,
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(sendReminders(env));
  },
} satisfies ExportedHandler<Env>;
