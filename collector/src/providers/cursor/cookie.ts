type PlainRecord = Record<string, unknown>;

function decodeJwtSub(jwt: string): string | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payloadSegment = parts[1];
    if (payloadSegment === undefined) {
      return undefined;
    }
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const payloadText = Buffer.from(padded, "base64").toString("utf8");
    const payload = JSON.parse(payloadText) as unknown;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return undefined;
    }
    const sub = (payload as PlainRecord).sub;
    return typeof sub === "string" && sub.length > 0 ? sub : undefined;
  } catch {
    return undefined;
  }
}

/** Shapes a discovered session token into the WorkosCursorSessionToken cookie value. */
export function formatSessionCookieValue(token: string): string | undefined {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let decoded = trimmed;
  if (trimmed.includes("%")) {
    try {
      decoded = decodeURIComponent(trimmed);
    } catch {
      return undefined;
    }
  }

  const separator = decoded.indexOf("::");
  if (separator > 0) {
    const sub = decoded.slice(0, separator);
    const jwt = decoded.slice(separator + 2);
    if (sub.length > 0 && jwt.includes(".")) {
      return `${sub}::${jwt}`;
    }
  }

  if (decoded.includes(".")) {
    const sub = decodeJwtSub(decoded);
    if (sub === undefined) {
      return undefined;
    }
    return `${sub}::${decoded}`;
  }

  return undefined;
}
