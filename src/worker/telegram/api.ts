import type { Env } from "../env";

// Minimal Telegram Bot API types — only the fields this app reads.

export interface TgUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TgVoice {
  file_id: string;
  duration: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel" };
  text?: string;
  voice?: TgVoice;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

async function callApi<T>(env: Env, method: string, payload: unknown): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as { ok: boolean; result?: T; description?: string };
  if (!body.ok) {
    throw new Error(`Telegram ${method} failed: ${body.description ?? res.status}`);
  }
  return body.result as T;
}

export interface SendOptions {
  replyMarkup?: unknown;
}

export async function sendMessage(
  env: Env,
  chatId: number | string,
  html: string,
  options: SendOptions = {},
): Promise<void> {
  await callApi(env, "sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    reply_markup: options.replyMarkup,
  });
}

/** Downloads a file (e.g. a voice note) from Telegram's file storage. */
export async function downloadFile(env: Env, fileId: string): Promise<ArrayBuffer> {
  const file = await callApi<{ file_path?: string }>(env, "getFile", { file_id: fileId });
  if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
  const res = await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
  );
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return res.arrayBuffer();
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
