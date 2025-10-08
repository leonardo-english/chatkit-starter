import { WORKFLOW_ID } from "@/lib/config";

export const runtime = "edge";

interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  workflowId?: string | null;
}

const DEFAULT_CHATKIT_BASE = "https://api.openai.com";
const SESSION_COOKIE_NAME = "chatkit_session_id";
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export async function POST(request: Request): Promise<Response> {
  let sessionCookie: string | null = null;

  try {
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      return new Response(
        JSON.stringify({ error: "Missing OPENAI_API_KEY environment variable" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const parsedBody = await safeParseJson<CreateSessionRequestBody>(request);
    const { userId, sessionCookie: resolvedSessionCookie } = await resolveUserId(request);
    sessionCookie = resolvedSessionCookie;

    const resolvedWorkflowId =
      parsedBody?.workflow?.id ?? parsedBody?.workflowId ?? WORKFLOW_ID;

    // Debug breadcrumbs (shows in Vercel logs)
    console.log("[create-session] workflowId:", resolvedWorkflowId);
    console.log("[create-session] origin:", request.headers.get("origin"));

    if (!resolvedWorkflowId) {
      return buildJsonResponse(
        { error: "Missing workflow id" },
        400,
        { "Content-Type": "application/json" },
        sessionCookie,
      );
    }

    // NOTE: Do not send `metadata` or `session` – the API rejects unknown params.
    const url = `${DEFAULT_CHATKIT_BASE}/v1/chatkit/sessions`;
    const upstreamResponse = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiApiKey}`,
        "OpenAI-Beta": "chatkit_beta=v1",
      },
      body: JSON.stringify({
        workflow: { id: resolvedWorkflowId },
        user: userId,
      }),
    });

    const upstreamJson = (await upstreamResponse
      .json()
      .catch(() => ({}))) as Record<string, unknown> | undefined;

    if (!upstreamResponse.ok) {
      console.error("[create-session] upstream body:", JSON.stringify(upstreamJson));
      return buildJsonResponse(
        { error: upstreamJson },
        upstreamResponse.status,
        { "Content-Type": "application/json" },
        sessionCookie,
      );
    }

    const clientSecret = (upstreamJson?.client_secret ?? null) as string | null;
    const expiresAfter = upstreamJson?.expires_after ?? null;

    return buildJsonResponse(
      { client_secret: clientSecret, expires_after: expiresAfter },
      200,
      { "Content-Type": "application/json" },
      sessionCookie,
    );
  } catch (_err) {
    return buildJsonResponse(
      { error: "Unexpected error" },
      500,
      { "Content-Type": "application/json" },
      sessionCookie,
    );
  }
}

// ---------- helpers ----------

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

function buildJsonResponse(
  payload: unknown,
  status: number,
  headers: Record<string, string>,
  sessionCookie: string | null,
): Response {
  const responseHeaders = new Headers(headers);
  if (sessionCookie) responseHeaders.append("Set-Cookie", sessionCookie);
  return new Response(JSON.stringify(payload), { status, headers: responseHeaders });
}