/** A count with its grouping separator and a singular or plural noun. */
export const formatCount = (count: number, singular: string, plural = `${singular}s`) =>
  `${count.toLocaleString()} ${count === 1 ? singular : plural}`;

/** How long until a stored file expires, as "in 12 days", or null once it has expired. */
export const formatExpiry = (expiresAt: string, now = new Date()) => {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (left <= 0) return null;
  const words = new Intl.RelativeTimeFormat([], { numeric: "always" });
  if (left >= 86_400_000) return words.format(Math.round(left / 86_400_000), "day");
  if (left >= 3_600_000) return words.format(Math.floor(left / 3_600_000), "hour");
  return words.format(Math.max(1, Math.floor(left / 60_000)), "minute");
};

/** Clock time for today's messages; the date alone for anything older, as in a mail list. */
export const formatFeedTime = (value: string, now = new Date()) => {
  const at = new Date(value);
  if (at.toDateString() === now.toDateString())
    return at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.getFullYear() === now.getFullYear()
    ? at.toLocaleDateString([], { month: "short", day: "numeric" })
    : at.toLocaleDateString([], { year: "2-digit", month: "numeric", day: "numeric" });
};

/** When a refused action can be tried again, in the reader's own clock. */
export const formatRetry = (retryAt: string, now = new Date()) => {
  const at = new Date(retryAt);
  const minutes = Math.ceil((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 1) return "You can try again in a minute.";
  if (minutes < 60) return `You can try again in ${minutes} minutes.`;
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (at.toDateString() === now.toDateString()) return `You can try again after ${time} today.`;
  if (at.toDateString() === tomorrow.toDateString())
    return `You can try again after ${time} tomorrow.`;
  return `You can try again after ${at.toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" })}.`;
};
