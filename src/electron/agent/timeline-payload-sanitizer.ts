import type { TaskEvent } from "../../shared/types";

const MAX_TIMELINE_STRING_CHARS = 60_000;
const MAX_TIMELINE_SANITIZE_DEPTH = 12;

const BASE64_IMAGE_FIELD_NAMES = new Set([
  "imagebase64",
  "image_base64",
  "screenshotbase64",
  "screenshot_base64",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shouldOmitImageString(key: string | undefined, value: string): boolean {
  const normalizedKey = (key || "").toLowerCase();
  if (BASE64_IMAGE_FIELD_NAMES.has(normalizedKey)) return value.length > 0;
  if (value.startsWith("data:image/")) return true;
  return normalizedKey.includes("imagebase64") || normalizedKey.includes("screenshotbase64");
}

function truncateLargeString(value: string): string {
  if (value.length <= MAX_TIMELINE_STRING_CHARS) return value;

  const omittedChars = value.length - MAX_TIMELINE_STRING_CHARS;
  return `${value.slice(0, MAX_TIMELINE_STRING_CHARS)}\n[... truncated ${omittedChars} chars for timeline storage ...]`;
}

function sanitizeValue(
  value: unknown,
  key: string | undefined,
  depth: number,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") {
    if (shouldOmitImageString(key, value)) {
      return {
        omitted: true,
        reason: "base64 image payload",
        originalChars: value.length,
      };
    }
    return truncateLargeString(value);
  }

  if (!value || typeof value !== "object") return value;

  if (seen.has(value)) {
    return "[circular timeline payload reference omitted]";
  }
  if (depth >= MAX_TIMELINE_SANITIZE_DEPTH) {
    return "[nested timeline payload omitted]";
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => sanitizeValue(entry, undefined, depth + 1, seen));
    }

    if (!isRecord(value)) return value;

    const sanitized: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitizedValue = sanitizeValue(entryValue, entryKey, depth + 1, seen);
      const normalizedKey = entryKey.toLowerCase();
      if (
        typeof entryValue === "string" &&
        shouldOmitImageString(entryKey, entryValue) &&
        (BASE64_IMAGE_FIELD_NAMES.has(normalizedKey) ||
          normalizedKey.includes("imagebase64") ||
          normalizedKey.includes("screenshotbase64"))
      ) {
        sanitized[`${entryKey}Omitted`] = true;
        sanitized[`${entryKey}OriginalChars`] = entryValue.length;
        continue;
      }
      sanitized[entryKey] = sanitizedValue;
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeTimelinePayloadForStorage(payload: unknown): unknown {
  return sanitizeValue(payload, undefined, 0, new WeakSet<object>());
}

export function sanitizeTimelineEventForStorage<T extends TaskEvent>(event: T): T {
  return {
    ...event,
    payload: sanitizeTimelinePayloadForStorage(event.payload),
  };
}
