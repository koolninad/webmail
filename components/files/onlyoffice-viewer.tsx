// host-patch target path:  components/files/onlyoffice-viewer.tsx  (NEW FILE)
//
// CORE-owned OnlyOffice editor view. Rendered by the Files page for files whose
// extension is claimed by a file-viewer plugin (here: nubo-onlyoffice). It is
// hosted OUTSIDE the plugin sandbox because the production plugin iframe is
// sandbox="allow-scripts" (opaque origin), which OnlyOffice's nested editor
// iframe cannot operate inside (lib/plugin-sandbox/host-bridge.ts:128-131).
//
// It loads DocsAPI from office.nubo.email and POSTs /api/onlyoffice/config to
// get the signed editor config. This is the same contract the plugin's
// src/index.js implements; the logic is mirrored here so the editor runs in the
// host's same-origin document.
//
// CSP: the host CSP must allow office.nubo.email in script-src/frame-src/
// connect-src/img-src. The plugin's manifest.frameOrigins/httpOrigins feed the
// plugin CSP, not the host page CSP, so add office.nubo.email to the host CSP
// (see PLAN.md §CSP). This is the one extra host-config change for the core path.

"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/browser-navigation";
import { getActiveAccountSlotHeaders } from "@/lib/auth/active-account-slot";
import { useAuthStore } from "@/stores/auth-store";
import type { FileViewerTarget } from "@/lib/plugin-types";

const DOCS_API_SRC = "https://office.nubo.email/web-apps/apps/api/documents/api.js";

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (id: string, config: unknown) => { destroyEditor: () => void } };
  }
}

let docsApiPromise: Promise<Window["DocsAPI"]> | null = null;
function loadDocsApi(): Promise<Window["DocsAPI"]> {
  if (window.DocsAPI) return Promise.resolve(window.DocsAPI);
  if (docsApiPromise) return docsApiPromise;
  docsApiPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = DOCS_API_SRC;
    s.async = true;
    s.onload = () => (window.DocsAPI ? resolve(window.DocsAPI) : reject(new Error("DocsAPI missing")));
    s.onerror = () => { docsApiPromise = null; reject(new Error("Failed to load OnlyOffice api.js")); };
    document.head.appendChild(s);
  });
  return docsApiPromise;
}

async function fetchSignedConfig(file: FileViewerTarget): Promise<Record<string, unknown>> {
  const { client } = useAuthStore.getState();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...getActiveAccountSlotHeaders() };
  if (client) {
    headers["Authorization"] = client.getAuthHeader();
    headers["X-JMAP-Username"] = client.getUsername();
  }
  const res = await apiFetch("/api/onlyoffice/config", {
    method: "POST",
    headers,
    body: JSON.stringify({ path: file.path, name: file.name, version: file.version, mode: "edit" }),
  });
  if (!res.ok) throw new Error(`config ${res.status}`);
  const data = await res.json();
  if (!data?.config) throw new Error("no config returned");
  return data.config as Record<string, unknown>;
}

interface OnlyOfficeViewerProps {
  file: FileViewerTarget;
  onClose: () => void;
}

export function OnlyOfficeViewer({ file, onClose }: OnlyOfficeViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<{ destroyEditor: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await fetchSignedConfig(file);
        (config as { events?: unknown }).events = {
          // OnlyOffice's onError event.data may be a string OR an object
          // ({errorCode, errorDescription}). Coerce to a string — rendering the
          // raw object as a React child throws (React #31) and crashes the page.
          onError: (e: { data?: unknown }) => {
            if (cancelled) return;
            const d = e?.data;
            setError(
              typeof d === "string" ? d
              : d && typeof d === "object" ? JSON.stringify(d)
              : "editor error",
            );
          },
          onRequestClose: () => onClose(),
        };
        const DocsAPI = await loadDocsApi();
        if (cancelled || !containerRef.current || !DocsAPI) return;
        if (!containerRef.current.id) containerRef.current.id = "onlyoffice-editor";
        editorRef.current = new DocsAPI.DocEditor(containerRef.current.id, config);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
      try { editorRef.current?.destroyEditor(); } catch { /* ignore */ }
    };
  }, [file.path, file.name, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <h3 className="text-sm font-medium truncate">{file.name}</h3>
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="relative flex-1 min-h-0">
        {error ? (
          <div className="p-4 text-sm text-destructive">OnlyOffice: {error}</div>
        ) : (
          <div ref={containerRef} className="absolute inset-0 w-full h-full" />
        )}
      </div>
    </div>
  );
}
