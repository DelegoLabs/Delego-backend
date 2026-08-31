import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { json } from "./http.js";

const DEFAULT_PUBLIC_PATHS = ["/health", "/vapid-public-key"];

interface AuthOptions {
  publicPaths?: string[];
}

function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "===".slice(0, (4 - (padded.length % 4)) % 4);
  return Buffer.from(padded + padding, "base64");
}

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be set and at least 32 characters long");
  }
  return secret;
}

function verifyHmac(token: string, secret: string): { userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const signature = base64urlDecode(encodedSignature);

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const hmac = createHmac("SHA256", secret);
  hmac.update(signingInput);
  const expectedSignature = hmac.digest();

  if (signature.length !== expectedSignature.length) return null;
  if (!timingSafeEqual(signature, expectedSignature)) return null;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString("utf8"));
  } catch {
    return null;
  }

  if (payload.exp && typeof payload.exp === "number") {
    if (Date.now() >= payload.exp * 1000) return null;
  }

  const userId = typeof payload.userId === "string" ? payload.userId : typeof payload.sub === "string" ? payload.sub : null;
  return userId ? { userId } : null;
}

function isPublicPath(pathname: string, publicPaths: Set<string>): boolean {
  if (publicPaths.has(pathname)) return true;
  // `/health` in the public set also covers `/health/live`, `/health/metrics`, etc.
  if (publicPaths.has("/health") && (pathname === "/health" || pathname.startsWith("/health/"))) {
    return true;
  }
  return false;
}

export function requireAuth(options: AuthOptions = {}): (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void {
  const publicPaths = new Set(options.publicPaths ?? DEFAULT_PUBLIC_PATHS);

  return (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void): void => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (isPublicPath(pathname, publicPaths)) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="api"');
      json(res, 401, {
        data: null,
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      });
      return;
    }

    const token = authHeader.slice(7);
    let secret: string;
    try {
      secret = resolveJwtSecret();
    } catch {
      json(res, 401, {
        data: null,
        error: { code: "UNAUTHORIZED", message: "Invalid token" },
      });
      return;
    }

    const decoded = verifyHmac(token, secret);
    if (!decoded) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="api"');
      json(res, 401, {
        data: null,
        error: { code: "UNAUTHORIZED", message: "Invalid or expired token" },
      });
      return;
    }

    (req as IncomingMessage & { userId?: string }).userId = decoded.userId;
    next();
  };
}
