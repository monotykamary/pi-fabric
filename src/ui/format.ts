import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const safeText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
};

export const formatTokens = (tokens: number): string => {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  if (tokens < 100_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000).toFixed(0)}k`;
};

export const formatClock = (timestamp: number): string =>
  new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const padToWidth = (value: string, width: number): string => {
  const clipped = truncateToWidth(value, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

export const wrapPlainText = (value: string, width: number, maxLines = 100): string[] => {
  const safe = safeText(value);
  if (!safe || width <= 0 || maxLines <= 0) return [];
  const words = safe.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(truncateToWidth(current, width));
    current = word;
    while (visibleWidth(current) > width && lines.length < maxLines) {
      let chunk = "";
      let consumed = 0;
      for (const character of current) {
        const candidate = chunk + character;
        if (visibleWidth(candidate) > width) {
          if (!chunk) consumed += character.length;
          break;
        }
        chunk = candidate;
        consumed += character.length;
      }
      if (chunk) lines.push(chunk);
      current = current.slice(consumed);
    }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(truncateToWidth(current, width));
  return lines;
};
