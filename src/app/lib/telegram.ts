import WebApp from "@twa-dev/sdk";

export const tg = WebApp;

export const insideTelegram = Boolean(tg.initData);

export function init(): void {
  tg.ready();
  tg.expand();
}

export function haptic(kind: "light" | "success" | "error"): void {
  if (!insideTelegram) return;
  if (kind === "light") tg.HapticFeedback.impactOccurred("light");
  else tg.HapticFeedback.notificationOccurred(kind);
}

type MainButtonHandler = () => void;
let currentHandler: MainButtonHandler | null = null;

/**
 * Single owner of the Telegram MainButton. Pass null to hide.
 * Returns false when running outside Telegram so callers can render a fallback.
 */
export function setMainButton(
  config: { text: string; destructive?: boolean; onClick: MainButtonHandler } | null,
): boolean {
  if (!insideTelegram) return false;
  if (currentHandler) {
    tg.MainButton.offClick(currentHandler);
    currentHandler = null;
  }
  if (!config) {
    tg.MainButton.hide();
    return true;
  }
  currentHandler = config.onClick;
  tg.MainButton.setParams({
    text: config.text,
    color: config.destructive ? "#c0392b" : undefined,
    is_visible: true,
  });
  tg.MainButton.onClick(config.onClick);
  return true;
}
