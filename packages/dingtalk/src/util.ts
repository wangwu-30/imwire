export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function newId(prefix = "id"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Split so each piece is ≤ maxBytes of UTF-8 (DingTalk streaming 1 KB cap). */
export function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes <= 0) return [text];
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text || ""];
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    const next = buf + ch;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      if (buf) out.push(buf);
      buf = ch;
      if (Buffer.byteLength(buf, "utf8") > maxBytes) {
        out.push(buf);
        buf = "";
      }
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out.length > 0 ? out : [""];
}
