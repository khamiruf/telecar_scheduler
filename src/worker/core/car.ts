import type { Env } from "../env";
import type { CarStatus } from "@/shared/types";

interface StatusRow {
  level: string;
  updated_at: number;
  first_name: string | null;
}

export async function getCarStatus(env: Env): Promise<CarStatus | null> {
  const row = await env.DB.prepare(
    "SELECT s.level, s.updated_at, u.first_name FROM car_status s " +
      "LEFT JOIN users u ON u.telegram_id = s.updated_by WHERE s.id = 1",
  ).first<StatusRow>();
  if (!row) return null;
  return {
    level: row.level,
    updatedBy: row.first_name ?? "someone",
    updatedAt: row.updated_at,
  };
}

export async function setCarLocation(env: Env, level: string, byUserId: number): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO car_status (id, level, updated_by, updated_at) VALUES (1, ?1, ?2, unixepoch()) " +
      "ON CONFLICT (id) DO UPDATE SET level = ?1, updated_by = ?2, updated_at = unixepoch()",
  )
    .bind(level, byUserId)
    .run();
}
