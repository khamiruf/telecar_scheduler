export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  ADMIN_ID: string;
  GROUP_CHAT_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Local development only (.dev.vars): act as this Telegram user when no initData is sent. */
  DEV_USER_ID?: string;
}
