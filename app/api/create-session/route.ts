import { WORKFLOW_ID } from "@/lib/config";

export const runtime = "edge";

interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  workflowId?: string | null;

  // optional episode context from client
  episodeCode?: string | null;
  title?: string | null;
  mp3?: string | null;
}

interface UpstreamError {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

interface UpstreamOk {
  client_secret?: string | null;
  expires_after?: unknown;
}

type UpstreamBody = UpstreamOk & {
  error?: UpstreamError;
  message?: string;
};

const DEFAULT_CHATKIT_BASE = "https://api.openai.com";
const SESSION_COOKIE_NAME = "chatkit_session_id";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(request: Request): Promise<Response> {
  let sessionCookie: string | null = null;

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return json({ error: "Missing OPENAI_API_KEY" }, 500, null);
    }

    const body = await safeParseJson<CreateSessionRequestBody>(request);
    const { userId, sessionCookie: setCookie } = await resolveUserId(request);
    sessionCookie = setCookie;

    const resolvedWorkflowId = body?.workflow?.id ?? body?.workflowId ?? WORKFLOW_ID;
    if (!resolvedWorkflowId) {
      return json({ error: "Missing workflow id" }, 400, sessionCookie);
    }

    const episodeCode = body?.episodeCode ?? null;
    const title = body?.title ?? null;
    const mp3 = body?.mp3 ?? null;

    // Build upstream payload: use session.metadata (supported)
    const upstreamBody: Record<string, unknown> = {
      workflow: { id: resolvedWorkflowId },
      user: userId,
      session:
        episodeCode || title || mp3
          ? { metadata: { episodeCode, title, mp3 } }
          : undefined,
    };

    if (process.env.NODE_ENV !== "production") {
      console.log("[create-session] req", {
        workflowId: resolvedWorkflowId,
        userId,
        metadata: upstreamBody.session,
      });
    }

    const resp = await fetch(`${DEFAULT_CHATKIT_BASE}/v1/chatkit/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify(upstreamBody),
    });

    const text = await resp.text();
    const parsed: UpstreamBody = parseJsonSafe(text);

    if (!resp.ok) {
      const upstreamMsg = getUpstreamMessage(parsed, text);
      console.error("[create-session] upstream error", {
        status: resp.status,
        body: parsed || text,
      });
      return json(
        { error: upstreamMsg, details: parsed || text },
        resp.status,
        sessionCookie
      );
    }

    const clientSecret = parsed.client_secret ?? null;
    const expiresAfter = parsed.expires_after ?? null;

    return json({ client_secret: clientSecret, expires_after: expiresAfter }, 200, sessionCookie);
  } catch (e) {
    console.error("[create-session] unexpected", e);
    return json({ error: "Unexpected error" }, 500, sessionCookie);
  }
}

/* ---------------- helpers ---------------- */

function parseJsonSafe(text: string): UpstreamBody {
  try {
    return text ? (JSON.parse(text) as UpstreamBody) : {};
  } catch {
    return {};
  }
}

function getUpstreamMessage(body: UpstreamBody, fallbackText: string): string {
  if (typeof body.message === "string" && body.message) return body.message;
  if (body.error && typeof body.error.message === "string" && body.error.message) {
    return body.error.message;
  }
  return fallbackText || "Upstream error";
}

async function safeParseJson<T>(req: Request): Promise<T | null> {
  try {
    const text = await req.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function resolveUserId(request: Request): Promise<{
  userId: string;
  sessionCookie: string | null;
}> {
  const existing = getCookieValue(request.headers.get("cookie"), SESSION_COOKIE_NAME);
  if (existing) return { userId: existing, sessionCookie: null };

  const generated =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2);

  return { userId: generated, sessionCookie: serializeSessionCookie(generated) };
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const [rawName, ...rest] = cookie.split("=");
    if (!rawName || rest.length === 0) continue;
    if (rawName.trim() === name) return rest.join("=").trim();
  }
  return null;
}

function serializeSessionCookie(value: string): string {
  const attrs = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attrs.push("Secure");
  return attrs.join("; ");
}

function json(payload: unknown, status: number, sessionCookie: string | null) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (sessionCookie) headers.append("Set-Cookie", sessionCookie);
  return new Response(JSON.stringify(payload), { status, headers });
}