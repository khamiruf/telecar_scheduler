// All Mini App times use the device's local timezone.

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function toUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

export function dayName(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: "short" });
}

export function timeLabel(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function agoLabel(unixSeconds: number): string {
  const minutes = Math.max(0, (Date.now() / 1000 - unixSeconds) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.floor(minutes)}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
