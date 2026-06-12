import type { Env } from "../env";

export interface User {
  telegramId: number;
  firstName: string;
  isAdmin: boolean;
}

interface UserRow {
  telegram_id: number;
  first_name: string;
  is_admin: number;
}

export async function getUser(env: Env, telegramId: number): Promise<User | null> {
  const row = await env.DB.prepare(
    "SELECT telegram_id, first_name, is_admin FROM users WHERE telegram_id = ?",
  )
    .bind(telegramId)
    .first<UserRow>();
  if (row) {
    return {
      telegramId: row.telegram_id,
      firstName: row.first_name,
      isAdmin: row.is_admin === 1 || String(row.telegram_id) === env.ADMIN_ID,
    };
  }
  return null;
}

/** The admin is always authorized, even before the users table is seeded. */
export async function resolveAuthorizedUser(
  env: Env,
  telegramId: number,
  firstName: string,
): Promise<User | null> {
  const user = await getUser(env, telegramId);
  if (user) return user;
  if (String(telegramId) === env.ADMIN_ID) {
    await addUser(env, telegramId, firstName, true);
    return { telegramId, firstName, isAdmin: true };
  }
  return null;
}

export async function getAllUsers(env: Env): Promise<User[]> {
  const { results } = await env.DB.prepare(
    "SELECT telegram_id, first_name, is_admin FROM users",
  ).all<UserRow>();
  return results.map((row) => ({
    telegramId: row.telegram_id,
    firstName: row.first_name,
    isAdmin: row.is_admin === 1 || String(row.telegram_id) === env.ADMIN_ID,
  }));
}

export async function addUser(
  env: Env,
  telegramId: number,
  firstName: string,
  isAdmin = false,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, first_name, is_admin) VALUES (?, ?, ?) " +
      "ON CONFLICT (telegram_id) DO UPDATE SET first_name = excluded.first_name",
  )
    .bind(telegramId, firstName, isAdmin ? 1 : 0)
    .run();
}
