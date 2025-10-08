import { WORKFLOW_ID } from "@/lib/config";

export const runtime = "edge";

interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  scope?: { user_id?: string | null } | null;
  workflowId?: string | null;

  // episode metadata (optional)
  episodeCode?: string | null;
  title?: string | null;
  mp3?: string | null;
}

type UpstreamErrorObject = {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
};

type UpstreamResponse = {
  client_secret?: string | null;
  expires_after?: unknown;
  error?: string | UpstreamErrorObject;
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
      return json({ error: "Missing OPENAI_API_KEY environment variable" }, 500, null);
    }

    const parsedBody = await safeParseJson<CreateSessionRequestBody>(request);
    const { userId, sessionCookie: resolvedSessionCookie } = await resolveUserId(request);
    sessionCookie = resolvedSessionCookie ?? null;

    const resolvedWorkflowId =
      parsedBody?.workflow?.id ?? parsedBody?.workflowId ?? WORKFLOW_ID;

    if (!resolvedWorkflowId) {
      return json({ error: "Missing workflow id" }, 400, sessionCookie);
    }

    const episodeCode = parsedBody?.episodeCode ?? null;
    const title = parsedBody?.title ?? null;
    const mp3 = parsedBody?.mp3 ?? null;

    const apiBase = DEFAULT_CHATKIT_BASE;
    const url = `${apiBase}/v1/chatkit/sessions`;

    // ---- Attempt #1: metadata at top level ----
    let upstreamResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify({
        workflow: { id: resolvedWorkflowId },
        user: userId,
        metadata: episodeCode || title || mp3 ? { episodeCode, title, mp3 } : undefined,
      }),
    });

    let upstreamJson = (await upstreamResponse.json().catch(() => ({}))) as UpstreamResponse;

    const maybeErrorMsg = extractMessage(upstreamJson);

    const looksLikeUnknownMetadata =
      upstreamResponse.status === 400 &&
      maybeErrorMsg.toLowerCase().includes("unknown parameter") &&
      maybeErrorMsg.toLowerCase().includes("metadata");

    // ---- Attempt #2: fall back to session.metadata if needed ----
    if (!upstreamResponse.ok && looksLikeUnknownMetadata) {
      console.log("[create-session] retrying with session.metadata shape");
      upstreamResponse = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiApiKey}`,
          "OpenAI-Beta": "chatkit_beta=v1",
        },
        body: JSON.stringify({
          workflow: { id: resolvedWorkflowId },
          user: userId,
          session:
            episodeCode || title || mp3
              ? { metadata: { episodeCode, title, mp3 } }
              : undefined,
        }),
      });
      upstreamJson = (await upstreamResponse.json().catch(() => ({}))) as UpstreamResponse;
    }

    if (!upstreamResponse.ok) {
      console.error("[create-session] upstream error", {
        status: upstreamResponse.status,
        body: upstreamJson,
      });
      return json({ error: upstreamJson }, upstreamResponse.status, sessionCookie);
    }

    const clientSecret = (upstreamJson?.client_secret ?? null) as string | null;
    const expiresAfter = upstreamJson?.expires_after ?? null;

    return json({ client_secret: clientSecret, expires_after: expiresAfter }, 200, sessionCookie);
  } catch (e) {
    console.error("[create-session] unexpected error", e);
    return json({ error: "Unexpected error" }, 500, sessionCookie);
  }
}

/* ---------------- helpers ---------------- */

function extractMessage(payload: UpstreamResponse | undefined): string {
  if (!payload) return "";
  if (typeof payload.message === "string") return payload.message;

  const err = payload.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  if (typeof err.message === "string") return err.message;
  return "";
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
  if (existing) {
    return { userId: existing, sessionCookie: null };
  }
  const generated =
    typeof crypto.randomUUID === "function" ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return { userId: generated, sessionCookie: serializeSessionCookie(generated) };
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(";");
  for (const cookie of cookies) {
    const [rawName, ...rest] = cookie.split("=");
    if (!rawName || rest.length === 0) continue;
    if (rawName.trim() === name) return rest.join("=").trim();
  }
  return null;
}

function serializeSessionCookie(value: string): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${SESSION_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes.join("; ");
}

function json(payload: unknown, status: number, sessionCookie: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const responseHeaders = new Headers(headers);
  if (sessionCookie) responseHeaders.append("Set-Cookie", sessionCookie);
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}
