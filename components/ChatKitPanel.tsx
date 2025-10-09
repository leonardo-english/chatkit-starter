"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatKit, useChatKit } from "@openai/chatkit-react";
import {
  STARTER_PROMPTS,
  PLACEHOLDER_INPUT,
  GREETING,
  CREATE_SESSION_ENDPOINT,
  WORKFLOW_ID,
} from "@/lib/config";
import { ErrorOverlay } from "./ErrorOverlay";
import type { ColorScheme } from "@/hooks/useColorScheme";

export type FactAction = {
  type: "save";
  factId: string;
  factText: string;
};

type ChatKitPanelProps = {
  theme: ColorScheme;
  onWidgetAction: (action: FactAction) => Promise<void>;
  onResponseEnd: () => void;
  onThemeRequest: (scheme: ColorScheme) => void;
};

type ErrorState = {
  script: string | null;
  session: string | null;
  integration: string | null;
  retryable: boolean;
};

const isBrowser = typeof window !== "undefined";
const isDev = process.env.NODE_ENV !== "production";

const createInitialErrors = (): ErrorState => ({
  script: null,
  session: null,
  integration: null,
  retryable: false,
});

export function ChatKitPanel({
  theme,
  onWidgetAction,
  onResponseEnd,
  onThemeRequest,
}: ChatKitPanelProps) {
  const processedFacts = useRef(new Set<string>());
  const [errors, setErrors] = useState<ErrorState>(() => createInitialErrors());
  const [isInitializingSession, setIsInitializingSession] = useState(true);
  const isMountedRef = useRef(true);
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(
    () => (isBrowser && window.customElements?.get("openai-chatkit") ? "ready" : "pending"),
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Detect the ChatKit web component script availability (purely to surface a friendly error)
  useEffect(() => {
    if (!isBrowser) return;

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) return;
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js", event);
      if (!isMountedRef.current) return;
      setScriptStatus("error");
      const detail = (event as CustomEvent<unknown>)?.detail ?? "unknown error";
      setErrorState({ script: `Error: ${detail}`, retryable: false });
      setIsInitializingSession(false);
    };

    window.addEventListener("chatkit-script-loaded", handleLoaded);
    window.addEventListener("chatkit-script-error", handleError as EventListener);

    if (window.customElements?.get("openai-chatkit")) {
      handleLoaded();
    } else if (scriptStatus === "pending") {
      timeoutId = window.setTimeout(() => {
        if (!window.customElements?.get("openai-chatkit")) {
          handleError(
            new CustomEvent("chatkit-script-error", {
              detail: "ChatKit web component unavailable. Check CDN reachability.",
            }),
          );
        }
      }, 5000);
    }

    return () => {
      window.removeEventListener("chatkit-script-loaded", handleLoaded);
      window.removeEventListener("chatkit-script-error", handleError as EventListener);
      if (timeoutId) window.clearTimeout(timeoutId);
    };
  }, [scriptStatus, setErrorState]);

  const isWorkflowConfigured = Boolean(WORKFLOW_ID && !WORKFLOW_ID.startsWith("wf_replace"));

  useEffect(() => {
    if (!isWorkflowConfigured && isMountedRef.current) {
      setErrorState({
        session: "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.",
        retryable: false,
      });
      setIsInitializingSession(false);
    }
  }, [isWorkflowConfigured, setErrorState]);

  const handleResetChat = useCallback(() => {
    processedFacts.current.clear();
    if (isBrowser) {
      setScriptStatus(window.customElements?.get("openai-chatkit") ? "ready" : "pending");
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  /**
   * Where we read the episode context from:
   * 1) The embedding (Webflow) page URL (document.referrer)
   * 2) Fallback to this iframe's own URL (window.location.search)
   */
  const episodeCtx = useMemo(() => {
    if (!isBrowser) return null;

    let code: string | null = null;
    let title: string | null = null;
    let mp3: string | null = null;
    let from: "parent" | "self" | "none" = "none";

    try {
      const parentUrl = document.referrer ? new URL(document.referrer) : null;
      if (parentUrl) {
        const p = parentUrl.searchParams;
        code = p.get("episodeCode");
        title = p.get("title");
        mp3 = p.get("mp3");
        if (code) from = "parent";
      }
    } catch {
      /* cross-origin parsing can fail; ignore */
    }

    if (!code) {
      const p = new URLSearchParams(window.location.search);
      code = p.get("episodeCode");
      title = title ?? p.get("title");
      mp3 = mp3 ?? p.get("mp3");
      if (code) from = "self";
    }

    if (isDev) {
      console.info("[ChatKitPanel] episodeCtx", { from, code, title, mp3 });
    }

    if (!code) return null;
    return { episodeCode: code, title, mp3 };
  }, []);

  /**
   * Create a ChatKit session (no metadata in the POST body).
   * The agent will call our client tool to fetch episode context when needed.
   */
  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret", {
          currentSecretPresent: Boolean(currentSecret),
          workflowId: WORKFLOW_ID,
          endpoint: CREATE_SESSION_ENDPOINT,
        });
      }

      if (!isWorkflowConfigured) {
        const detail = "Set NEXT_PUBLIC_CHATKIT_WORKFLOW_ID in your .env.local file.";
        if (isMountedRef.current) {
          setErrorState({ session: detail, retryable: false });
          setIsInitializingSession(false);
        }
        throw new Error(detail);
      }

      if (isMountedRef.current) {
        if (!currentSecret) setIsInitializingSession(true);
        setErrorState({ session: null, integration: null, retryable: false });
      }

      const response = await fetch(CREATE_SESSION_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow: { id: WORKFLOW_ID } }),
      });

      const rawText = await response.text();
      let data: Record<string, unknown> = {};
      if (rawText) {
        try {
          data = JSON.parse(rawText) as Record<string, unknown>;
        } catch (e) {
          console.error("Failed to parse create-session response", e);
        }
      }

      if (isDev) {
        console.info("[ChatKitPanel] create-session result", {
          status: response.status,
          ok: response.ok,
          bodyPreview: rawText.slice(0, 1000),
        });
      }

      if (!response.ok) {
        const maybeError = (data?.error as { message?: string } | undefined)?.message;
        const detail = maybeError || response.statusText;
        if (isMountedRef.current) setErrorState({ session: detail, retryable: false });
        throw new Error(detail);
      }

      const clientSecret = data?.client_secret as string | undefined;
      if (!clientSecret) throw new Error("Missing client secret in response");

      if (isMountedRef.current) {
        setErrorState({ session: null, integration: null });
        if (!currentSecret) setIsInitializingSession(false);
      }

      return clientSecret;
    },
    [isWorkflowConfigured, setErrorState],
  );

  /**
   * Wire up the widget.
   * We DO NOT push hidden messages or actions.
   * Instead we implement a client tool the agent can call to fetch context.
   */
  const chatkit = useChatKit({
    api: { getClientSecret },
    theme: {
      colorScheme: theme,
      color: {
        grayscale: { hue: 220, tint: 6, shade: theme === "dark" ? -1 : -4 },
        accent: { primary: theme === "dark" ? "#f1f5f9" : "#0f172a", level: 1 },
      },
      radius: "round",
    },
    startScreen: { greeting: GREETING, prompts: STARTER_PROMPTS },
    composer: { placeholder: PLACEHOLDER_INPUT },
    threadItemActions: { feedback: false },

    onClientTool: async ({ name, params }: { name: string; params: Record<string, unknown> }) => {
      if (isDev) console.info("[ChatKitPanel] Client tool invoked:", name, params);

      // Let the agent toggle theme (keeps existing behaviour)
      if (name === "switch_theme") {
        const requested = params.theme;
        if (requested === "light" || requested === "dark") {
          onThemeRequest(requested as ColorScheme);
          return { ok: true };
        }
        return { ok: false };
      }

      // Let the agent “save fact” (keeps existing behaviour)
      if (name === "record_fact") {
        const id = String(params.fact_id ?? "");
        const text = String(params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) return { ok: true };
        processedFacts.current.add(id);
        await onWidgetAction({ type: "save", factId: id, factText: text.replace(/\s+/g, " ").trim() });
        return { ok: true };
      }

      // *** The important one: the agent asks us for the current episode context
      if (name === "request_episode_context") {
        // Prefer what we already computed
        let code = episodeCtx?.episodeCode ?? null;
        let title = episodeCtx?.title ?? null;
        let mp3 = episodeCtx?.mp3 ?? null;

        // Fallback to iframe URL if needed
        if (!code) {
          const p = new URLSearchParams(window.location.search);
          code = p.get("episodeCode");
          title = title ?? p.get("title");
          mp3 = mp3 ?? p.get("mp3");
        }

        if (isDev) console.info("[ChatKitPanel] returning episode context →", { code, title, mp3 });

        return {
          episodeCode: code,
          title,
          mp3,
        };
      }

      // Unknown tool → let the agent know it’s unsupported
      return { ok: false };
    },

    onResponseStart: () => {
      setErrorState({ integration: null, retryable: false });
    },

    onResponseEnd: () => {
      onResponseEnd();
    },

    onThreadChange: () => {
      // New thread → clear dedupe set for facts
      processedFacts.current.clear();
    },

    onError: ({ error }: { error: unknown }) => {
      console.error("ChatKit error", error);
    },
  });

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render", {
      isInitializingSession,
      hasControl: Boolean(chatkit.control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
      episodeCtx,
    });
  }

  return (
    <div className="relative flex h-[90vh] w-full flex-col overflow-hidden bg-white shadow-sm transition-colors dark:bg-slate-900">
      <ChatKit
        key={widgetInstanceKey}
        control={chatkit.control}
        className={
          blockingError || isInitializingSession ? "pointer-events-none opacity-0" : "block h-full w-full"
        }
      />
      <ErrorOverlay
        error={blockingError}
        fallbackMessage={blockingError || !isInitializingSession ? null : "Loading assistant session..."}
        onRetry={blockingError && errors.retryable ? handleResetChat : null}
        retryLabel="Restart chat"
      />
    </div>
  );
}