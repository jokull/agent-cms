import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import { useCmsEdit } from "./context.js";
import { useCmsRecord } from "./cms-record.js";

export interface CmsAgentProps {
  /** Override the chat API endpoint. Defaults to `${endpoint}/api/chat` */
  apiRoute?: string;
}

/**
 * Floating AI chat agent for CMS content editing.
 *
 * Place inside a `<CmsEditProvider>` and optionally inside a `<CmsRecord>`.
 * When inside a `<CmsRecord>`, the chat is pre-warmed with the record context
 * so the agent knows which record the user is editing.
 *
 * Only renders when edit mode is enabled.
 */
export function CmsAgent({ apiRoute }: CmsAgentProps) {
  const edit = useCmsEdit();
  const record = useCmsRecord();
  const [open, setOpen] = useState(false);

  if (!edit?.enabled) return null;

  return (
    <>
      {/* Floating toggle button */}
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          position: "fixed",
          bottom: 20,
          right: 20,
          width: 48,
          height: 48,
          borderRadius: "50%",
          border: "none",
          background: "#2563eb",
          color: "#fff",
          fontSize: 22,
          cursor: "pointer",
          boxShadow: "0 2px 10px rgba(0,0,0,0.2)",
          zIndex: 10000,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "system-ui, sans-serif",
        }}
        aria-label={open ? "Close CMS Agent" : "Open CMS Agent"}
      >
        {open ? "\u2715" : "\u2728"}
      </button>

      {open && (
        <ChatPanel
          apiRoute={apiRoute ?? `${edit.endpoint}/api/chat`}
          writeKey={edit.writeKey}
          recordId={record?.recordId}
          modelApiKey={record?.modelApiKey}
          locale={record?.locale}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

interface ChatPanelProps {
  apiRoute: string;
  writeKey: string;
  recordId?: string;
  modelApiKey?: string;
  locale?: string;
  onClose: () => void;
}

function ChatPanel({ apiRoute, writeKey, recordId, modelApiKey, locale, onClose }: ChatPanelProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [inputValue, setInputValue] = useState("");

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: apiRoute,
        headers: { Authorization: `Bearer ${writeKey}` },
        body: { recordId, modelApiKey, locale },
      }),
    [apiRoute, writeKey, recordId, modelApiKey, locale],
  );

  const { messages, sendMessage, status } = useChat({ transport });

  const isLoading = status === "submitted" || status === "streaming";

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = inputValue.trim();
      if (!text || isLoading) return;
      setInputValue("");
      sendMessage({ text });
    },
    [inputValue, isLoading, sendMessage],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div
      style={{
        position: "fixed",
        bottom: 80,
        right: 20,
        width: 400,
        height: 500,
        background: "#fff",
        borderRadius: 12,
        boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        zIndex: 10000,
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
        fontSize: 14,
        overflow: "hidden",
      }}
      onKeyDown={onKeyDown}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #e5e7eb",
          background: "#f9fafb",
        }}
      >
        <span style={{ fontWeight: 600, color: "#111827" }}>
          CMS Agent
          {modelApiKey && (
            <span style={{ fontWeight: 400, color: "#6b7280", marginLeft: 8, fontSize: 12 }}>
              {modelApiKey}{recordId ? ` / ${recordId.slice(0, 8)}...` : ""}
            </span>
          )}
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            fontSize: 18,
            cursor: "pointer",
            color: "#6b7280",
            padding: "0 4px",
          }}
          aria-label="Close"
        >
          {"\u2715"}
        </button>
      </div>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "12px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {messages.length === 0 && (
          <div style={{ color: "#9ca3af", textAlign: "center", marginTop: 40 }}>
            Ask me to edit content, translate fields, or manage assets.
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {isLoading && (
          <div style={{ color: "#9ca3af", fontSize: 12, padding: "4px 0" }}>Thinking...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: 8,
          padding: "12px 16px",
          borderTop: "1px solid #e5e7eb",
          background: "#f9fafb",
        }}
      >
        <input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Ask the CMS agent..."
          autoFocus
          style={{
            flex: 1,
            padding: "8px 12px",
            borderRadius: 8,
            border: "1px solid #d1d5db",
            fontSize: 14,
            outline: "none",
            fontFamily: "inherit",
          }}
        />
        <button
          type="submit"
          disabled={isLoading || !inputValue.trim()}
          style={{
            padding: "8px 16px",
            borderRadius: 8,
            border: "none",
            background: isLoading || !inputValue.trim() ? "#93c5fd" : "#2563eb",
            color: "#fff",
            fontSize: 13,
            fontWeight: 600,
            cursor: isLoading || !inputValue.trim() ? "default" : "pointer",
            fontFamily: "inherit",
          }}
        >
          Send
        </button>
      </form>
    </div>
  );
}

function MessageBubble({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  // Extract text and tool parts from the message
  const textContent = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  const toolParts = message.parts.filter(
    (p): p is typeof p & { toolCallId: string; state: string; input: unknown; output?: unknown } =>
      p.type.startsWith("tool-") && p.type !== "text" && "toolCallId" in p,
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {/* Tool invocations (collapsed) */}
      {toolParts.map((part) => {
        const toolName = part.type.replace(/^tool-/, "");
        return (
          <ToolCallSummary
            key={part.toolCallId}
            invocation={{ toolName, state: part.state, args: part.input, result: part.output }}
          />
        );
      })}

      {/* Text content */}
      {textContent && (
        <div
          style={{
            alignSelf: isUser ? "flex-end" : "flex-start",
            maxWidth: "85%",
            padding: "8px 12px",
            borderRadius: 12,
            background: isUser ? "#2563eb" : "#f3f4f6",
            color: isUser ? "#fff" : "#111827",
            lineHeight: 1.5,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {textContent}
        </div>
      )}
    </div>
  );
}

function ToolCallSummary({ invocation }: { invocation: { toolName: string; state: string; args: unknown; result?: unknown } }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        fontSize: 12,
        color: "#6b7280",
        background: "#f9fafb",
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "6px 10px",
        cursor: "pointer",
      }}
      onClick={() => setExpanded((e) => !e)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 10 }}>{expanded ? "\u25BC" : "\u25B6"}</span>
        <span>
          {invocation.state === "result" ? "\u2705" : "\u23F3"} {invocation.toolName}
        </span>
      </div>
      {expanded && (
        <pre
          style={{
            marginTop: 6,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 150,
            overflow: "auto",
            background: "#fff",
            padding: 6,
            borderRadius: 4,
          }}
        >
          {JSON.stringify({ args: invocation.args, result: invocation.result }, null, 2)}
        </pre>
      )}
    </div>
  );
}
