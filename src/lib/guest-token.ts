import { createHmac, timingSafeEqual } from "crypto";

const GUEST_TOKEN_TTL_MS = 1000 * 60 * 60 * 12;

interface GuestTokenPayload {
  userId: string;
  sessionId: string;
  exp: number;
}

function toBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function fromBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createGuestToken(userId: string, sessionId: string): string | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return null;
  }

  const payload: GuestTokenPayload = {
    userId,
    sessionId,
    exp: Date.now() + GUEST_TOKEN_TTL_MS,
  };
  const payloadEncoded = toBase64Url(JSON.stringify(payload));
  const signature = sign(payloadEncoded, secret);
  return `${payloadEncoded}.${signature}`;
}

export function verifyGuestToken(token: string): GuestTokenPayload | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    return null;
  }

  const [payloadEncoded, providedSignature] = token.split(".");
  if (!payloadEncoded || !providedSignature) {
    return null;
  }

  const expectedSignature = sign(payloadEncoded, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);

  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(fromBase64Url(payloadEncoded)) as GuestTokenPayload;
    if (!payload.userId || !payload.sessionId || !payload.exp) {
      return null;
    }
    if (payload.exp < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
