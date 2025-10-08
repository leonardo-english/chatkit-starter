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

  // Track current thread id and whether we already injected context.
  const latestThreadIdRef = useRef<string | null>(null);
  const injectedRef = useRef(false);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Load web component script sentinel
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
              detail: "ChatKit web component unavailable. Check the CDN.",
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
    injectedRef.current = false;
    latestThreadIdRef.current = null;

    if (isBrowser) {
      setScriptStatus(window.customElements?.get("openai-chatkit") ? "ready" : "pending");
    }
    setIsInitializingSession(true);
    setErrors(createInitialErrors());
    setWidgetInstanceKey((prev) => prev + 1);
  }, []);

  // -------- Resolve episode context (parent referrer preferred, then iframe URL) --------
  const episodeCtx = useMemo(() => {
    if (!isBrowser) return null;

    let from: "parent" | "self" | "none" = "none";
    let code: string | null = null;
    let title: string | undefined;
    let mp3: string | undefined;

    try {
      const parentUrl = document.referrer ? new URL(document.referrer) : null;
      if (parentUrl) {
        const p = parentUrl.searchParams;
        const c = p.get("episodeCode");
        if (c) {
          code = c;
          title = p.get("title") || undefined;
          mp3 = p.get("mp3") || undefined;
          from = "parent";
        }
      }
    } catch {
      // ignore cross-origin parsing errors
    }

    if (!code) {
      const params = new URLSearchParams(window.location.search);
      const c = params.get("episodeCode");
      if (c) {
        code = c;
        title = params.get("title") || undefined;
        mp3 = params.get("mp3") || undefined;
        from = "self";
      }
    }

    if (isDev) {
      console.info("[ChatKitPanel] episodeCtx", { from, code, title, mp3 });
    }

    if (!code) return null;
    return { code, title, mp3 };
  }, []);

  // -------- Create ChatKit session (no metadata in POST) --------
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

  // -------- Wire up ChatKit --------
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

    onThreadChange: ({ threadId }: { threadId: string | null }) => {
      if (isDev) console.info("[ChatKitPanel] onThreadChange", { threadId });
      latestThreadIdRef.current = threadId;

      // First time we see a non-null threadId → inject context once.
      if (threadId && !injectedRef.current && episodeCtx?.code) {
        injectedRef.current = true;
        // Fire on next macrotask to give the widget a tick to settle.
        setTimeout(() => {
          if (isDev) console.info("[ChatKitPanel] injecting set_episode_context (onThreadChange)", episodeCtx);
          chatkit
            .sendCustomAction({
              type: "set_episode_context",
              payload: {
                episodeCode: episodeCtx.code,
                title: episodeCtx.title,
                mp3: episodeCtx.mp3,
              },
            })
            .catch((e: unknown) => {
              injectedRef.current = false; // allow fallback onResponseStart
              console.error("Failed to send set_episode_context in onThreadChange", e);
            });
        }, 0);
      }
    },

    onResponseStart: async () => {
      // Fallback: if somehow we didn't inject yet, do it now.
      if (!injectedRef.current && episodeCtx?.code) {
        injectedRef.current = true;
        try {
          if (isDev) console.info("[ChatKitPanel] injecting set_episode_context (onResponseStart)", episodeCtx);
          await chatkit.sendCustomAction({
            type: "set_episode_context",
            payload: {
              episodeCode: episodeCtx.code,
              title: episodeCtx.title,
              mp3: episodeCtx.mp3,
            },
          });
        } catch (e) {
          console.error("Failed to inject context in onResponseStart", e);
        }
      }
      setErrorState({ integration: null, retryable: false });
    },

    onResponseEnd: () => {
      onResponseEnd();
    },

    onClientTool: async (invocation: { name: string; params: Record<string, unknown> }) => {
      if (invocation.name === "switch_theme") {
        const requested = invocation.params.theme;
        if (requested === "light" || requested === "dark") {
          if (isDev) console.debug("[ChatKitPanel] switch_theme", requested);
          onThemeRequest(requested as ColorScheme);
          return { success: true };
        }
        return { success: false };
      }

      if (invocation.name === "record_fact") {
        const id = String(invocation.params.fact_id ?? "");
        const text = String(invocation.params.fact_text ?? "");
        if (!id || processedFacts.current.has(id)) return { success: true };
        processedFacts.current.add(id);
        void onWidgetAction({
          type: "save",
          factId: id,
          factText: text.replace(/\s+/g, " ").trim(),
        });
        return { success: true };
      }

      return { success: false };
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
      injected: injectedRef.current,
      latestThreadId: latestThreadIdRef.current,
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