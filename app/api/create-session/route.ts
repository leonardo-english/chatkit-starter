import { WORKFLOW_ID } from "@/lib/config";

export const runtime = "edge";

interface CreateSessionRequestBody {
  workflow?: { id?: string | null } | null;
  scope?: { user_id?: string | null } | null;
  workflowId?: string | null;

  // episode metadata
  episodeCode?: string | null;
  title?: string | null;
  mp3?: string | null;
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
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    const parsedBody = await safeParseJson<CreateSessionRequestBody>(request);
    const { userId, sessionCookie: resolvedSessionCookie } = await resolveUserId(request);
    sessionCookie = resolvedSessionCookie;

    const resolvedWorkflowId =
      parsedBody?.workflow?.id ?? parsedBody?.workflowId ?? WORKFLOW_ID;

    // --- DEBUG LOGGING ---
    console.log("[create-session] openaiApiKey present:", !!openaiApiKey);
    console.log("[create-session] workflowId:", resolvedWorkflowId);
    console.log("[create-session] origin:", request.headers.get("origin"));
    console.log("[create-session] episodeCode:", parsedBody?.episodeCode);
    console.log("[create-session] title:", parsedBody?.title);
    console.log("[create-session] mp3:", parsedBody?.mp3);
    // ---------------------

    if (!resolvedWorkflowId) {
      return buildJsonResponse(
        { error: "Missing workflow id" },
        400,
        { "Content-Type": "application/json" },
        sessionCookie
      );
    }

    // episode metadata passed from frontend
    const episodeCode = parsedBody?.episodeCode ?? null;
    const title = parsedBody?.title ?? null;
    const mp3 = parsedBody?.mp3 ?? null;

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
        metadata: {
          episodeCode,
          title,
          mp3,
        },
      }),
    });

    const upstreamJson = (await upstreamResponse.json().catch(() => ({}))) as
      | Record<string, unknown>
      | undefined;

    if (!upstreamResponse.ok) {
      return buildJsonResponse(
        { error: upstreamJson },
        upstreamResponse.status,
        { "Content-Type": "application/json" },
        sessionCookie
      );
    }

    const clientSecret = (upstreamJson?.client_secret ?? null) as string | null;
    const expiresAfter = upstreamJson?.expires_after ?? null;

    return buildJsonResponse(
      { client_secret: clientSecret, expires_after: expiresAfter },
      200,
      { "Content-Type": "application/json" },
      sessionCookie
    );
  } catch (error) {
    return buildJsonResponse(
      { error: "Unexpected error" },
      500,
      { "Content-Type": "application/json" },
      sessionCookie
    );
  }
}
