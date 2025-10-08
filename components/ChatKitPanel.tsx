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
  const [scriptStatus, setScriptStatus] = useState<"pending" | "ready" | "error">(() =>
    isBrowser && window.customElements?.get("openai-chatkit") ? "ready" : "pending",
  );
  const [widgetInstanceKey, setWidgetInstanceKey] = useState(0);

  const [hasInjected, setHasInjected] = useState(false);
  const latestThreadIdRef = useRef<string | null>(null);

  const setErrorState = useCallback((updates: Partial<ErrorState>) => {
    setErrors((current) => ({ ...current, ...updates }));
  }, []);

  useEffect(() => () => { isMountedRef.current = false; }, []);

  useEffect(() => {
    if (!isBrowser) return;

    let timeoutId: number | undefined;

    const handleLoaded = () => {
      if (!isMountedRef.current) return;
      setScriptStatus("ready");
      setErrorState({ script: null });
    };

    const handleError = (event: Event) => {
      console.error("Failed to load chatkit.js for some reason", event);
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
          handleError(new CustomEvent("chatkit-script-error", {
            detail: "ChatKit web component is unavailable. Verify that the script URL is reachable.",
          }));
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
    setHasInjected(false);
    latestThreadIdRef.current = null;
  }, []);

  // -------- Episode context (parent referrer first, then iframe URL) --------
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
      // ignore
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
      console.info("[ChatKitPanel] episodeCtx resolved", { from, code, title, mp3 });
    }

    if (!code) return null;
    return { code, title, mp3 };
  }, []);

  // -------- Create ChatKit session (no metadata in POST!) --------
  const getClientSecret = useCallback(
    async (currentSecret: string | null) => {
      if (isDev) {
        console.info("[ChatKitPanel] getClientSecret invoked", {
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
      try { if (rawText) data = JSON.parse(rawText) as Record<string, unknown>; } catch (e) {
        console.error("Failed to parse create-session response", e);
      }

      if (isDev) {
        console.info("[ChatKitPanel] createSession response", {
          status: response.status, ok: response.ok, bodyPreview: rawText.slice(0, 1600),
        });
      }

      if (!response.ok) {
        const detail =
          typeof (data?.error as { message?: string } | undefined)?.message === "string"
            ? (data!.error as { message: string }).message
            : response.statusText;
        if (isMountedRef.current) setErrorState({ session: detail, retryable: false });
        throw new Error(detail);
      }

      const clientSecret = data?.client_secret as string | undefined;
      if (!clientSecret) throw new Error("Missing client secret in response");

      if (isMountedRef.current) setErrorState({ session: null, integration: null });
      if (isMountedRef.current && !currentSecret) setIsInitializingSession(false);

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
    },

    onResponseStart: async () => {
      // Safety net: if somehow we still haven't injected by the time the first response begins,
      // do it here (thread definitely exists now).
      if (!hasInjected && episodeCtx?.code) {
        try {
          if (isDev) console.info("[ChatKitPanel] onResponseStart -> inject fallback", episodeCtx);
          await chatkit.sendCustomAction({
            type: "set_episode_context",
            payload: {
              episodeCode: episodeCtx.code,
              title: episodeCtx.title,
              mp3: episodeCtx.mp3,
            },
          });
          setHasInjected(true);
        } catch (e) {
          console.error("Failed to inject context in onResponseStart", e);
        }
      }
      setErrorState({ integration: null, retryable: false });
    },

    onResponseEnd: () => onResponseEnd(),

    onError: ({ error }: { error: unknown }) => {
      console.error("ChatKit error", error);
    },
  });

  // Create a thread ASAP once control is ready, then inject context once.
  useEffect(() => {
    const run = async () => {
      if (!chatkit.control) return;
      if (hasInjected) return;

      // Ensure thread exists
      let tid = latestThreadIdRef.current;
      if (!tid) {
        if (isDev) console.info("[ChatKitPanel] no thread yet → creating one");
        try {
          tid = await chatkit.createThread(); // chatkit-react exposes this helper
          latestThreadIdRef.current = tid;
          if (isDev) console.info("[ChatKitPanel] created thread", { threadId: tid });
        } catch (e) {
          console.error("Failed to create thread", e);
          return;
        }
      }

      // Inject once we have both a thread and context
      if (episodeCtx?.code && !hasInjected) {
        try {
          if (isDev) console.info("[ChatKitPanel] injecting set_episode_context", episodeCtx);
          await chatkit.sendCustomAction({
            type: "set_episode_context",
            payload: {
              episodeCode: episodeCtx.code,
              title: episodeCtx.title,
              mp3: episodeCtx.mp3,
            },
          });
          setHasInjected(true);
        } catch (e) {
          console.error("Failed to send set_episode_context", e);
        }
      }
    };

    void run();
  }, [chatkit.control, episodeCtx, hasInjected, chatkit]);

  const activeError = errors.session ?? errors.integration;
  const blockingError = errors.script ?? activeError;

  if (isDev) {
    console.debug("[ChatKitPanel] render state", {
      isInitializingSession,
      hasControl: Boolean(chatkit.control),
      scriptStatus,
      hasError: Boolean(blockingError),
      workflowId: WORKFLOW_ID,
      episodeCtx,
      hasInjected,
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