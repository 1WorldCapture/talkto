/** A count with its grouping separator and a singular or plural noun. */
export const formatCount = (count: number, singular: string, plural = `${singular}s`) =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const yesterdayOf = (now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);

/** List time, as in Messages: clock time today, then "Yesterday", the weekday, then the date. */
export function formatListTime(value: string, now = new Date()) {
  const at = new Date(value);
  if (sameDay(at, now)) return at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay(at, yesterdayOf(now))) return "Yesterday";
  if (now.getTime() - at.getTime() < 6 * 86_400_000)
    return at.toLocaleDateString([], { weekday: "long" });
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleDateString([], { month: "numeric", day: "numeric" })
    : at.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
}

/** A message's own clock time. */
export const formatClock = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Day headings inside a conversation. */
export function formatDay(value: string, now = new Date()) {
  const at = new Date(value);
  if (sameDay(at, now)) return "Today";
  if (sameDay(at, yesterdayOf(now))) return "Yesterday";
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })
    : at.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

/** A full date and time for details. */
export const formatDateTime = (value: string) =>
  new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

const ago = (amount: number, unit: string) => `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;

/**
 * "2 minutes ago", for an agent's last activity. Hermes has no Intl.RelativeTimeFormat, so the
 * app writes the English itself, like the rest of its copy.
 */
export function formatAgo(value: string, now = new Date()) {
  const seconds = Math.floor((now.getTime() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return ago(Math.floor(seconds / 60), "minute");
  if (seconds < 86_400) return ago(Math.floor(seconds / 3600), "hour");
  if (seconds < 30 * 86_400) return ago(Math.floor(seconds / 86_400), "day");
  return formatDateTime(value);
}

/** File sizes in the units Finder uses. */
export function formatBytes(bytes: number) {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toLocaleString([], { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** One line of a message for a list row: Markdown markers and line breaks removed. */
export const excerptOf = (body: string) =>
  body
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
