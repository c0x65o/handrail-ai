import { Fragment, createElement, useCallback, useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { createHandrailAiClient, type HandrailAiClient } from "../client/bootstrap.js";
import { createAttachmentUploader, type AttachmentUploader } from "../attachments/uploader.js";
import type { ApplicationGatewayAttachmentSource } from "../transports/application-gateway.js";
import { AI_RUNTIME_PROTOCOL_VERSION, type ChatRequest, type StreamEvent } from "../protocol.js";
import type { ConversationClientId, ConversationDeviceId } from "../conversation/events.js";
import type { ConversationAttachmentReference } from "../conversation/events.js";
import type { ConversationApprovalProposalRecord, ConversationMessageRecord, ConversationState, ConversationToolResultRecord } from "../conversation/state.js";
import type { PresenceController } from "../presence/controller.js";
import { emitAiDiagnostic, type AiDiagnosticSink } from "../diagnostics.js";
import type { MessageAttachmentRenderer, MessageContentRenderer, ToolResultRenderer } from "../react/primitives.js";
import { ConversationProvider } from "../react/context.js";
import { useConversationComposer, type ConversationComposerResult, type UseConversationComposerOptions } from "../react/use-conversation-composer.js";
import { useSmartTranscriptFollow } from "../react/transcript-follow.js";
import { useResolvedState } from "../react/primitive-context.js";
import type { ConversationRuntime } from "../runtime.js";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationCatalog, ConversationCatalogDescriptor } from "../conversation/catalog.js";
import type { ConversationWorkspaceOpenInput } from "../conversation/workspace.js";
import { useConversationLauncherBinding, useConversationWorkspaceSnapshot,
  type ConversationActivityReadable, type ConversationWorkspaceReadable } from "../react/workspace.js";
import type { ChatLauncherConnectionStatus } from "../react/launcher.js";
import {
  AttachmentList, ChatRoot, Composer, ErrorList, FileInput, Form, LiveRegion,
  AssistantActivityIndicator, Message, Retry, Stop, StreamStatus, Submit, Textarea, Transcript, TypingIndicator,
} from "../react/primitives.js";
import { CopyMessageButton } from "../react/message-actions.js";
import { CitationList } from "../react/citations.js";
import { ChatLauncherBadge, ChatLauncherPanel, ChatLauncherPortal, ChatLauncherRoot,
  ChatLauncherStatus, ChatLauncherTitle, ChatLauncherTrigger } from "../react/launcher.js";
import { ChatDialogContent, ChatDialogOverlay, ChatDialogPortal, ChatDialogRoot, ChatDialogTrigger } from "../react/dialog.js";
import { ChatDrawerContent, ChatDrawerOverlay, ChatDrawerPortal, ChatDrawerRoot, ChatDrawerTrigger, type ChatDrawerSide } from "../react/drawer.js";

export const HANDRAIL_CHAT_PRESET_VERSION = "handrail.react-preset.v1" as const;
export const HANDRAIL_ASSISTANT_UI_STANDARD_VERSION = "handrail.ai-assistant-ui.v1" as const;

export type StyledChatLayout = "launcher" | "dialog" | "drawer" | "page";
export type HandrailChatThemeMode = "light" | "dark" | "system";

export interface HandrailChatTheme {
  readonly mode?: HandrailChatThemeMode;
  readonly colors?: Partial<{
    accent: string;
    background: string;
    panel: string;
    text: string;
    muted: string;
    border: string;
    danger: string;
    activity: string;
  }>;
  readonly radii?: Partial<{ panel: string; message: string; control: string }>;
  readonly fontFamily?: string;
}

export interface ToolResultRendererRegistry {
  readonly [rendererKey: string]: (result: ConversationToolResultRecord) => ReactNode;
}

export interface ToolRendererPlugin {
  readonly pluginId: string;
  readonly version: string;
  readonly renderers: ToolResultRendererRegistry;
  readonly toolRendererKeys?: Readonly<Record<string, string>>;
}

/** Data-only subset returned by AiApplication.catalog(). */
export interface ToolRendererCatalog {
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly version: string;
    readonly presentations: readonly {
      readonly toolName: string;
      readonly rendererKey: string;
    }[];
  }[];
}

export function installToolRendererPlugins(
  plugins: readonly ToolRendererPlugin[],
  catalog?: ToolRendererCatalog,
): {
  readonly renderers: ToolResultRendererRegistry;
  readonly toolRendererKeys: Readonly<Record<string, string>>;
} {
  const renderers: Record<string, ToolResultRendererRegistry[string]> = {};
  const toolRendererKeys: Record<string, string> = {};
  const identities = new Set<string>();
  const installMapping = (toolName: string, key: string) => {
    const existing = toolRendererKeys[toolName];
    if (existing !== undefined && existing !== key) {
      throw new TypeError(`Conflicting renderer mapping for "${toolName}"`);
    }
    toolRendererKeys[toolName] = key;
  };
  for (const plugin of plugins) {
    const identity = `${plugin.pluginId}@${plugin.version}`;
    if (identities.has(identity)) throw new TypeError(`Duplicate renderer plugin "${identity}"`);
    identities.add(identity);
    for (const [key, renderer] of Object.entries(plugin.renderers)) {
      if (renderers[key]) throw new TypeError(`Duplicate renderer key "${key}"`);
      renderers[key] = renderer;
    }
    for (const [toolName, key] of Object.entries(plugin.toolRendererKeys ?? {})) {
      if (!renderers[key] && !plugin.renderers[key]) throw new TypeError(`Renderer plugin maps "${toolName}" to an unknown key`);
      installMapping(toolName, key);
    }
  }
  for (const plugin of catalog?.plugins ?? []) {
    if (!identities.has(`${plugin.pluginId}@${plugin.version}`)) continue;
    for (const presentation of plugin.presentations) {
      if (renderers[presentation.rendererKey]) {
        installMapping(presentation.toolName, presentation.rendererKey);
      }
    }
  }
  return Object.freeze({ renderers: Object.freeze(renderers), toolRendererKeys: Object.freeze(toolRendererKeys) });
}

export interface StyledChatPresetProps {
  readonly title?: ReactNode;
  readonly layout?: StyledChatLayout;
  readonly composer?: ConversationComposerResult;
  readonly state?: ConversationState;
  readonly presence?: PresenceController;
  readonly conversationPicker?: ReactNode;
  readonly approvals?: ReactNode;
  readonly citations?: ReactNode;
  readonly emptyState?: ReactNode;
  readonly footer?: ReactNode;
  /** Optional transcription or realtime-voice controls rendered beside Attach. */
  readonly voiceControls?: ReactNode;
  /** Safe semantic Markdown for assistant/system messages. Enabled by default. */
  readonly markdown?: boolean;
  /** Normalized citations are rendered below their target message by default. */
  readonly messageCitations?: boolean;
  /** Enabled by default; disable when the host renders its own message actions. */
  readonly messageActions?: boolean;
  readonly renderMessageContent?: MessageContentRenderer;
  readonly renderMessageAttachment?: MessageAttachmentRenderer;
  /** Resolves authorized, short-lived display URLs. Opaque references are never treated as URLs. */
  readonly resolveAttachmentUrl?: (
    attachment: ConversationAttachmentReference,
    message: ConversationMessageRecord,
  ) => string | undefined;
  readonly toolRendererKeys?: Readonly<Record<string, string>>;
  readonly toolResultRenderers?: ToolResultRendererRegistry;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** Typed tokens layered over the selected light, dark, or system preset. */
  readonly theme?: HandrailChatTheme;
  readonly labels?: Partial<{ attach: string; send: string; stop: string; retry: string; placeholder: string }>;
}

export interface HandrailChatProps<TRequest> extends Omit<StyledChatPresetProps,
  "composer" | "state" | "presence" | "toolRendererKeys" | "toolResultRenderers"> {
  readonly runtime: ConversationRuntime<TRequest>;
  readonly composer: UseConversationComposerOptions<TRequest>;
  readonly presence?: PresenceController;
  readonly rendererPlugins?: readonly ToolRendererPlugin[];
  /** Optional server catalog that automatically binds presentation renderer keys. */
  readonly toolCatalog?: ToolRendererCatalog;
}

const DEFAULT_LABELS = { attach: "Attach", send: "Send", stop: "Stop", retry: "Retry", placeholder: "Message…" };

/** A zero-runtime-dependency stylesheet; copy or override every custom property. */
export const handrailChatPresetCss = `
.hr-chat{--hr-accent:#635bff;--hr-bg:#fff;--hr-panel:#f6f7fb;--hr-text:#171927;--hr-muted:#687083;--hr-border:#dfe3eb;--hr-danger:#a32020;--hr-activity:#6750a4;--hr-radius-panel:16px;--hr-radius-message:12px;--hr-radius-control:9px;--hr-font:ui-sans-serif,system-ui,sans-serif;color:var(--hr-text);background:var(--hr-bg);border:1px solid var(--hr-border);border-radius:var(--hr-radius-panel);display:grid;grid-template-rows:auto minmax(12rem,1fr) auto;inline-size:min(100%,48rem);block-size:min(80dvh,48rem);font:400 14px/1.5 var(--hr-font);overflow:hidden;box-shadow:0 16px 50px #17192720}
.hr-chat[data-theme=dark]{--hr-accent:#9f9aff;--hr-bg:#171927;--hr-panel:#242735;--hr-text:#f4f5fa;--hr-muted:#aeb5c4;--hr-border:#3b4051;--hr-danger:#ff8c8c;--hr-activity:#c7b8ff}@media(prefers-color-scheme:dark){.hr-chat[data-theme=system]{--hr-accent:#9f9aff;--hr-bg:#171927;--hr-panel:#242735;--hr-text:#f4f5fa;--hr-muted:#aeb5c4;--hr-border:#3b4051;--hr-danger:#ff8c8c;--hr-activity:#c7b8ff}}
.hr-chat[data-layout=page]{inline-size:100%;block-size:100dvh;border:0;border-radius:0}.hr-chat[data-layout=drawer]{border-radius:var(--hr-radius-panel) 0 0 var(--hr-radius-panel);max-inline-size:30rem}.hr-chat__sr{block-size:1px;clip:rect(0 0 0 0);clip-path:inset(50%);inline-size:1px;overflow:hidden;position:absolute;white-space:nowrap}.hr-chat__header{align-items:center;border-block-end:1px solid var(--hr-border);display:flex;gap:.75rem;padding:.85rem 1rem}.hr-chat__header h2{font-size:1rem;margin:0}.hr-chat__picker{margin-inline-start:auto}.hr-chat__body{display:grid;grid-template-columns:minmax(0,1fr);min-block-size:0}.hr-chat__transcript{overflow:auto;padding:1rem;scrollbar-gutter:stable}.hr-chat [role=listitem]{background:var(--hr-panel);border-radius:var(--hr-radius-message);margin:.5rem 0;max-inline-size:85%;padding:.7rem .85rem;white-space:pre-wrap}.hr-chat [aria-label='user message']{background:var(--hr-accent);color:white;margin-inline-start:auto}.hr-chat__message-actions{display:flex;justify-content:flex-end;margin-block-start:.25rem}.hr-chat__message-actions button{font-size:.75rem;padding:.25rem .45rem}.hr-message-action-status:not(:empty){margin-inline-start:.4rem}.hr-chat__status{align-items:center;color:var(--hr-muted);display:flex;gap:.75rem;min-block-size:1.5rem;padding-inline:1rem}.hr-chat__composer{border-block-start:1px solid var(--hr-border);padding:.75rem}.hr-chat__attachments{display:flex;gap:.5rem;list-style:none;margin:0 0 .5rem;padding:0}.hr-chat__form{display:grid;gap:.5rem;grid-template-columns:auto minmax(0,1fr) auto auto}.hr-chat textarea{background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:var(--hr-radius-control);color:inherit;min-block-size:2.75rem;padding:.65rem;resize:none}.hr-chat button,.hr-chat__file{align-items:center;background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:var(--hr-radius-control);color:inherit;cursor:pointer;display:inline-flex;padding:.6rem .75rem}.hr-chat button[type=submit]{background:var(--hr-accent);color:#fff}.hr-chat button:focus-visible,.hr-chat textarea:focus-visible,.hr-chat input:focus-visible{outline:3px solid color-mix(in srgb,var(--hr-accent),transparent 55%);outline-offset:2px}.hr-chat button:disabled{cursor:not-allowed;opacity:.5}.hr-chat__errors{color:var(--hr-danger);grid-column:1/-1}.hr-chat__aux{border-block-start:1px solid var(--hr-border);padding:.75rem 1rem}@media(max-width:520px){.hr-chat{block-size:100dvh;border:0;border-radius:0;inline-size:100%}.hr-chat__form{grid-template-columns:auto minmax(0,1fr) auto}.hr-chat__retry{display:none}}@media(prefers-reduced-motion:reduce){.hr-chat *{scroll-behavior:auto!important;transition:none!important}}
.hr-chat__markdown{overflow-wrap:anywhere;white-space:normal}.hr-chat__markdown>:first-child{margin-block-start:0}.hr-chat__markdown>:last-child{margin-block-end:0}.hr-chat__markdown pre{max-inline-size:100%;overflow:auto;white-space:pre}.hr-chat__markdown code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}.hr-chat__markdown a{color:inherit;text-decoration:underline}.hr-chat__message-citations{font-size:.78rem;margin:.5rem 0 0;padding-inline-start:1.25rem}.hr-chat__message-citations li{background:transparent;margin:.15rem 0;max-inline-size:none;padding:0}.hr-chat__message-citations li>span:last-child{color:var(--hr-muted);margin-inline-start:.35rem}.hr-chat__attachment-card{align-items:center;border:1px solid var(--hr-border);border-radius:10px;color:inherit;display:flex;gap:.65rem;min-inline-size:11rem;overflow:hidden;padding:.5rem;text-decoration:none}.hr-chat__attachment-card img{block-size:5rem;inline-size:7rem;object-fit:cover}.hr-chat__attachment-copy{display:flex;min-inline-size:0;flex-direction:column}.hr-chat__attachment-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hr-chat__attachment-copy small{color:var(--hr-muted)}.hr-chat__voice{align-items:center;display:flex}
.hr-chat__transcript-wrap{display:grid;min-block-size:0;position:relative}.hr-chat__transcript-wrap>.hr-chat__transcript{min-block-size:0}.hr-chat__jump{inset-block-end:.75rem;inset-inline-end:.75rem;position:absolute;z-index:1}.hr-chat__assistant-activity:not(:empty){font-weight:600}
.hr-chat__launcher-trigger{align-items:center;display:inline-flex;gap:.45rem}.hr-chat__launcher-status{font-size:.75rem;font-weight:600}.hr-chat__launcher-trigger[data-busy=true] .hr-chat__launcher-status{color:var(--hr-activity)}.hr-chat__launcher-trigger[data-error=true] .hr-chat__launcher-status{color:var(--hr-danger)}.hr-chat__launcher-badge:empty{display:none}.hr-chat__launcher-badge{align-items:center;background:var(--hr-danger);border-radius:999px;color:#fff;display:inline-flex;font-size:.7rem;justify-content:center;min-block-size:1.2rem;min-inline-size:1.2rem;padding-inline:.25rem}
.hr-chat__workspace-picker{align-items:flex-start;display:flex;gap:.4rem;position:relative}.hr-chat__workspace-picker summary{background:var(--hr-panel,#f6f7fb);border:1px solid var(--hr-border,#dfe3eb);border-radius:9px;cursor:pointer;list-style:none;padding:.6rem .75rem}.hr-chat__workspace-picker summary::-webkit-details-marker{display:none}.hr-chat__workspace-picker ul{background:var(--hr-bg,#fff);border:1px solid var(--hr-border,#dfe3eb);display:grid;gap:.25rem;inset-block-start:100%;inset-inline-end:0;list-style:none;margin:0;max-block-size:16rem;min-inline-size:14rem;overflow:auto;padding:.35rem;position:absolute;z-index:10}.hr-chat__workspace-picker li{margin:0;padding:0}.hr-chat__workspace-picker li button{align-items:center;display:flex;inline-size:100%;justify-content:space-between;max-inline-size:none;text-align:start}.hr-chat__workspace-picker small{color:var(--hr-muted,#687083);margin-inline-start:.5rem}.hr-chat__workspace-picker [data-turn-status=running] small{color:#6750a4}.hr-chat__empty{display:grid;min-block-size:12rem;place-items:center;padding:1rem}
.hr-chat__approvals{display:grid;gap:.5rem}.hr-chat__approval{background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:var(--hr-radius-control);display:grid;gap:.4rem;padding:.65rem}.hr-chat__approval-actions{display:flex;gap:.5rem}.hr-chat__approval-error{color:var(--hr-danger)}
`;

export function StyledChatPresetStyles(): ReactNode {
  return <style data-handrail-ai-preset={HANDRAIL_CHAT_PRESET_VERSION}>{handrailChatPresetCss}</style>;
}

type HandrailThemeStyle = CSSProperties & Record<`--hr-${string}`, string>;

/** Convert typed theme tokens to the stable CSS custom-property contract. */
export function createHandrailChatThemeStyle(theme: HandrailChatTheme = {}): HandrailThemeStyle {
  const style: HandrailThemeStyle = {};
  const colors = theme.colors;
  if (colors?.accent !== undefined) style["--hr-accent"] = colors.accent;
  if (colors?.background !== undefined) style["--hr-bg"] = colors.background;
  if (colors?.panel !== undefined) style["--hr-panel"] = colors.panel;
  if (colors?.text !== undefined) style["--hr-text"] = colors.text;
  if (colors?.muted !== undefined) style["--hr-muted"] = colors.muted;
  if (colors?.border !== undefined) style["--hr-border"] = colors.border;
  if (colors?.danger !== undefined) style["--hr-danger"] = colors.danger;
  if (colors?.activity !== undefined) style["--hr-activity"] = colors.activity;
  if (theme.radii?.panel !== undefined) style["--hr-radius-panel"] = theme.radii.panel;
  if (theme.radii?.message !== undefined) style["--hr-radius-message"] = theme.radii.message;
  if (theme.radii?.control !== undefined) style["--hr-radius-control"] = theme.radii.control;
  if (theme.fontFamily !== undefined) style["--hr-font"] = theme.fontFamily;
  return style;
}

/** Accessible responsive drop-in surface; all headless primitives remain independently usable. */
export function StyledChatPreset(props: StyledChatPresetProps): ReactNode {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const renderContent = props.renderMessageContent ?? (props.markdown === false
    ? undefined
    : renderSafeMessageMarkdown);
  const renderAttachment = props.renderMessageAttachment ?? (props.resolveAttachmentUrl
    ? defaultAttachmentRenderer(props.resolveAttachmentUrl)
    : undefined);
  const renderToolResult: ToolResultRenderer | undefined = props.toolResultRenderers ? (result, toolCall) => {
    const key = props.toolRendererKeys?.[toolCall.name ?? ""];
    const renderer = key ? props.toolResultRenderers?.[key] : undefined;
    return renderer ? renderer(result) : <pre>{JSON.stringify(result.content, null, 2)}</pre>;
  } : undefined;
  return <ChatRoot
    className={["hr-chat", props.className].filter(Boolean).join(" ")}
    data-layout={props.layout ?? "page"}
    data-theme={props.theme?.mode ?? "light"}
    style={{ ...createHandrailChatThemeStyle(props.theme), ...props.style }}
    {...(props.composer ? { composer: props.composer } : {})}
    {...(props.state ? { state: props.state } : {})}
    {...(props.presence ? { presence: props.presence } : {})}
  >
    <header className="hr-chat__header"><h2>{props.title ?? "Assistant"}</h2>{props.conversationPicker && <div className="hr-chat__picker">{props.conversationPicker}</div>}</header>
    <main className="hr-chat__body">
      <FollowedTranscript className="hr-chat__transcript" {...(renderToolResult ? { renderToolResult } : {})}
        {...(renderAttachment ? { renderAttachment } : {})}
        {...(props.messageActions === false ? {} : { renderMessage: (message, _index, context) => <div>
          <Message message={message} error={context.error} toolCalls={context.toolCalls}
            {...(renderContent ? { renderContent } : {})}
            {...(renderAttachment ? { renderAttachment } : {})}
            {...(renderToolResult ? { renderToolResult } : {})}/>
          {props.messageCitations === false ? null : <CitationList
            className="hr-chat__message-citations" messageId={message.message_id}/>}
          <div className="hr-chat__message-actions"><CopyMessageButton message={message}/></div>
        </div> })}>{props.emptyState}</FollowedTranscript>
      <div className="hr-chat__status"><StreamStatus/><AssistantActivityIndicator className="hr-chat__assistant-activity"/><TypingIndicator/></div>
      <LiveRegion/>
    </main>
    {(props.approvals || props.citations) && <aside className="hr-chat__aux">{props.approvals}{props.citations}</aside>}
    <Composer className="hr-chat__composer">
      <AttachmentList className="hr-chat__attachments"/>
      <Form className="hr-chat__form">
        {props.voiceControls && <div className="hr-chat__voice">{props.voiceControls}</div>}
        <label className="hr-chat__file">{labels.attach}<FileInput hidden/></label>
        <Textarea rows={1} placeholder={labels.placeholder}/>
        <Stop>{labels.stop}</Stop><Retry className="hr-chat__retry">{labels.retry}</Retry>
        <Submit>{labels.send}</Submit><ErrorList className="hr-chat__errors"/>
      </Form>
    </Composer>
    {props.footer}
  </ChatRoot>;
}

function FollowedTranscript(props: ComponentProps<typeof Transcript>): ReactNode {
  const state = useResolvedState(props.state);
  const contentVersion = `${String(state?.revision ?? "none")}:${state?.messages.length ?? 0}:${state?.active_turn_id ?? "idle"}`;
  const follow = useSmartTranscriptFollow({ contentVersion });
  return <div className="hr-chat__transcript-wrap">
    <Transcript {...props} ref={follow.transcriptRef} onScroll={(event) => {
      props.onScroll?.(event);
      if (!event.defaultPrevented) follow.onScroll(event);
    }}/>
    {follow.hasNewContent && !follow.following
      ? <button className="hr-chat__jump" type="button" aria-label="Jump to latest message"
          onClick={() => follow.scrollToLatest()}>New messages</button>
      : null}
  </div>;
}

function messageText(parts: ConversationMessageRecord["content"]): string {
  return parts.map((part) => part.text).join("");
}

function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  if (trimmed.startsWith("#")) return trimmed;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

const renderSafeMessageMarkdown: MessageContentRenderer = (parts, message) => {
  const text = messageText(parts);
  if (message?.role === "user") return <span>{text}</span>;
  return <div className="hr-chat__markdown">{safeMarkdownBlocks(text)}</div>;
};

function safeMarkdownInline(text: string, blockKey: string): ReactNode[] {
  const output: ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`/gu;
  let cursor = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const offset = match.index;
    if (offset > cursor) output.push(text.slice(cursor, offset));
    const label = match[1];
    const destination = match[2];
    const code = match[3];
    if (code !== undefined) {
      output.push(<code key={`${blockKey}-code-${index}`}>{code}</code>);
    } else if (label !== undefined && destination !== undefined) {
      const href = safeMarkdownUrl(destination);
      const external = href.startsWith("http://") || href.startsWith("https://");
      output.push(href === ""
        ? <span key={`${blockKey}-link-${index}`}>{label}</span>
        : <a key={`${blockKey}-link-${index}`} href={href} {...(external
          ? { target: "_blank", rel: "noopener noreferrer" }
          : {})}>{label}</a>);
    }
    cursor = offset + match[0].length;
    index += 1;
  }
  if (cursor < text.length) output.push(text.slice(cursor));
  return output;
}

/** A deliberately small safe Markdown presentation with no parser/runtime dependency. */
function safeMarkdownBlocks(text: string): ReactNode[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const output: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") { index += 1; continue; }
    if (line.startsWith("```")) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith("```")) {
        code.push(lines[index] ?? ""); index += 1;
      }
      if (index < lines.length) index += 1;
      output.push(<pre key={`pre-${index}`}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading !== null) {
      const level = heading[1]!.length;
      output.push(createElement(`h${level}`, { key: `heading-${index}` },
        ...safeMarkdownInline(heading[2]!, `heading-${index}`)));
      index += 1;
      continue;
    }
    if (/^[-*]\s+/u.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length && /^[-*]\s+/u.test(lines[index] ?? "")) {
        const item = (lines[index] ?? "").replace(/^[-*]\s+/u, "");
        items.push(<li key={`item-${index}`}>{safeMarkdownInline(item, `item-${index}`)}</li>);
        index += 1;
      }
      output.push(<ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() !== "" &&
      !/^(?:#{1,6}\s+|[-*]\s+|```)/u.test(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? ""); index += 1;
    }
    output.push(<p key={`paragraph-${index}`}>{paragraph.map((value, lineIndex) =>
      <Fragment key={`line-${lineIndex}`}>{lineIndex === 0 ? null : <br/>}
        {safeMarkdownInline(value, `paragraph-${index}-${lineIndex}`)}</Fragment>)}</p>);
  }
  return output;
}

function safeAttachmentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    return ["http:", "https:", "blob:"].includes(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function attachmentSize(value: number | undefined): string | null {
  if (value === undefined) return null;
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(value / 1024))} KB`;
}

function defaultAttachmentRenderer(
  resolve: NonNullable<StyledChatPresetProps["resolveAttachmentUrl"]>,
): MessageAttachmentRenderer {
  return (attachment, message) => {
    const url = safeAttachmentUrl(resolve(attachment, message));
    const name = attachment.filename ?? (attachment.media_type === "application/pdf" ? "PDF document" : "Image");
    const size = attachmentSize(attachment.size_bytes);
    const content = <>
      {attachment.media_type.startsWith("image/") && url
        ? <img alt={`${name} preview`} loading="lazy" src={url}/>
        : <strong aria-hidden="true">{attachment.media_type === "application/pdf" ? "PDF" : "FILE"}</strong>}
      <span className="hr-chat__attachment-copy"><strong>{name}</strong>
        <small>{[attachment.media_type, size].filter(Boolean).join(" · ")}</small></span>
    </>;
    return url
      ? <a className="hr-chat__attachment-card" href={url}
          {...(url.startsWith("http") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{content}</a>
      : <span className="hr-chat__attachment-card">{content}</span>;
  };
}

function BoundHandrailChat<TRequest>(props: HandrailChatProps<TRequest>): ReactNode {
  const composer = useConversationComposer(props.composer);
  const installed = installToolRendererPlugins(props.rendererPlugins ?? [], props.toolCatalog);
  const { runtime: _runtime, rendererPlugins: _plugins, toolCatalog: _catalog,
    composer: _composer, presence: _presence, ...preset } = props;
  void _runtime; void _plugins; void _catalog; void _composer; void _presence;
  return <StyledChatPreset {...preset} composer={composer} {...(props.presence ? { presence: props.presence } : {})}
    toolRendererKeys={installed.toolRendererKeys} toolResultRenderers={installed.renderers}/>;
}

/** One-component optional UI; pass a headless runtime to retain full host control. */
export function HandrailChat<TRequest>(props: HandrailChatProps<TRequest>): ReactNode {
  return <ConversationProvider runtime={props.runtime}><BoundHandrailChat {...props}/></ConversationProvider>;
}

export interface ConversationWorkspaceController<TRequest, TAuthorizationContext>
  extends ConversationWorkspaceReadable {
  open(input: ConversationWorkspaceOpenInput<TAuthorizationContext>): Promise<ConversationRuntime<TRequest>>;
  select(conversationId: ConversationId | null): void;
  close?(conversationId: ConversationId): Promise<boolean>;
}

export interface ConversationCatalogWorkspaceOptions<TAuthorizationContext> {
  readonly catalog: ConversationCatalog<TAuthorizationContext>;
  readonly authorizationContext: TAuthorizationContext;
  /** Page size used while hydrating every authorized descriptor. Defaults to 50. */
  readonly pageSize?: number;
}

export interface WorkspaceThreadPickerProps<TRequest, TAuthorizationContext> {
  readonly workspace: ConversationWorkspaceController<TRequest, TAuthorizationContext>;
  readonly createConversation?: () => Promise<ConversationWorkspaceOpenInput<TAuthorizationContext>>;
  readonly getThreadLabel?: (conversationId: ConversationId) => ReactNode;
}

/** Compact open-thread picker that never blocks New while another turn runs. */
export function WorkspaceThreadPicker<TRequest, TAuthorizationContext>(
  props: WorkspaceThreadPickerProps<TRequest, TAuthorizationContext>,
): ReactNode {
  const snapshot = useConversationWorkspaceSnapshot(props.workspace);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const create = async () => {
    if (!props.createConversation || creating) return;
    setCreating(true); setError("");
    try { await props.workspace.open(await props.createConversation()); }
    catch { setError("Conversation could not be created."); }
    finally { setCreating(false); }
  };
  return <div className="hr-chat__workspace-picker">
    {props.createConversation && <button type="button" disabled={creating} aria-busy={creating}
      onClick={() => void create()}>{creating ? "Creating…" : "New"}</button>}
    <details><summary>Threads{snapshot.runningCount > 0 ? ` (${snapshot.runningCount} running)` : ""}</summary>
    <ul aria-label="Open conversations">{snapshot.threads.map((thread) =>
      <li key={thread.conversationId}><button type="button"
        aria-current={snapshot.selectedConversationId === thread.conversationId ? "true" : undefined}
        data-turn-status={thread.turnStatus}
        onClick={() => props.workspace.select(thread.conversationId)}>
        <span>{props.getThreadLabel?.(thread.conversationId) ?? thread.conversationId}</span>
        <small>{thread.turnStatus === "running" ? "Running" : thread.unread ? "Done" : thread.turnStatus}</small>
      </button></li>)}</ul></details>
    {error && <span role="alert">{error}</span>}
  </div>;
}

export interface CatalogWorkspaceThreadPickerProps<TRequest, TAuthorizationContext>
  extends WorkspaceThreadPickerProps<TRequest, TAuthorizationContext> {
  readonly catalogOptions: ConversationCatalogWorkspaceOptions<TAuthorizationContext>;
}

/** Paginated authorized catalog picker with reversible archive lifecycle controls. */
export function CatalogWorkspaceThreadPicker<TRequest, TAuthorizationContext>(
  props: CatalogWorkspaceThreadPickerProps<TRequest, TAuthorizationContext>,
): ReactNode {
  const snapshot = useConversationWorkspaceSnapshot(props.workspace);
  const [descriptors, setDescriptors] = useState<readonly ConversationCatalogDescriptor[]>([]);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [busyId, setBusyId] = useState<ConversationId | "create" | null>(null);
  const [error, setError] = useState("");
  const { catalog, authorizationContext } = props.catalogOptions;
  const pageSize = props.catalogOptions.pageSize ?? 50;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const found: ConversationCatalogDescriptor[] = [];
        let cursor: Awaited<ReturnType<typeof catalog.list>>["nextCursor"] | undefined;
        do {
          const page = await catalog.list({ authorizationContext, lifecycle: "all", pageSize,
            order: { field: "updated_at", direction: "desc" }, ...(cursor ? { cursor } : {}) });
          found.push(...page.items);
          cursor = page.nextCursor ?? undefined;
          if (!page.hasMore) break;
        } while (cursor);
        if (cancelled) return;
        setDescriptors(found);
        const active = found.filter((descriptor) => descriptor.lifecycle === "active");
        for (const descriptor of active) {
          await props.workspace.open({ authorizationContext,
            conversationId: descriptor.conversationId, select: false });
        }
        if (props.workspace.getSnapshot().selectedConversationId === null && active[0]) {
          props.workspace.select(active[0].conversationId);
        }
      } catch { if (!cancelled) setError("Conversations could not be loaded."); }
    })();
    return () => { cancelled = true; };
  }, [authorizationContext, catalog, pageSize, props.workspace, refreshRevision]);
  const create = async () => {
    if (!props.createConversation || busyId !== null) return;
    setBusyId("create"); setError("");
    try { await props.workspace.open(await props.createConversation()); setRefreshRevision((value) => value + 1); }
    catch { setError("Conversation could not be created."); }
    finally { setBusyId(null); }
  };
  const mutate = async (descriptor: ConversationCatalogDescriptor) => {
    if (busyId !== null) return;
    setBusyId(descriptor.conversationId); setError("");
    try {
      if (descriptor.lifecycle === "active") {
        await catalog.archive({ authorizationContext, conversationId: descriptor.conversationId,
          expectedVersion: descriptor.version, idempotencyKey: browserIdentity("archive") as never });
        await props.workspace.close?.(descriptor.conversationId);
      } else {
        await catalog.restore({ authorizationContext, conversationId: descriptor.conversationId,
          expectedVersion: descriptor.version, idempotencyKey: browserIdentity("restore") as never });
        await props.workspace.open({ authorizationContext, conversationId: descriptor.conversationId });
      }
      setRefreshRevision((value) => value + 1);
    } catch { setError(descriptor.lifecycle === "active"
      ? "Conversation could not be archived." : "Conversation could not be restored."); }
    finally { setBusyId(null); }
  };
  const labels = new Map(descriptors.map((descriptor) => [descriptor.conversationId, descriptor.title]));
  const archived = descriptors.filter((descriptor) => descriptor.lifecycle === "archived");
  return <div className="hr-chat__workspace-picker">
    {props.createConversation && <button type="button" disabled={busyId !== null} aria-busy={busyId === "create"}
      onClick={() => void create()}>{busyId === "create" ? "Creating…" : "New"}</button>}
    <details><summary>Threads{snapshot.runningCount > 0 ? ` (${snapshot.runningCount} running)` : ""}</summary>
      <ul aria-label="Conversations">{snapshot.threads.map((thread) => {
        const descriptor = descriptors.find((item) => item.conversationId === thread.conversationId);
        return <li key={thread.conversationId} data-turn-status={thread.turnStatus}>
          <button type="button" aria-current={snapshot.selectedConversationId === thread.conversationId ? "true" : undefined}
            onClick={() => props.workspace.select(thread.conversationId)}>
            <span>{props.getThreadLabel?.(thread.conversationId) ?? labels.get(thread.conversationId) ?? thread.conversationId}</span>
            <small>{thread.turnStatus === "running" ? "Running" : thread.unread ? "Done" : thread.turnStatus}</small>
          </button>
          {descriptor && catalog.capabilities.archive.supported && <button type="button"
            disabled={busyId !== null} aria-label={`Archive ${descriptor.title ?? "conversation"}`}
            onClick={() => void mutate(descriptor)}>Archive</button>}
        </li>;
      })}
      {archived.map((descriptor) => <li key={descriptor.conversationId}>
        <span>{descriptor.title ?? descriptor.conversationId}</span>
        {catalog.capabilities.restore.supported && <button type="button" disabled={busyId !== null}
          aria-label={`Restore ${descriptor.title ?? "conversation"}`}
          onClick={() => void mutate(descriptor)}>Restore</button>}
      </li>)}</ul>
    </details>
    {error && <span role="alert">{error}</span>}
  </div>;
}

export interface HandrailChatWorkspaceProps<TRequest, TAuthorizationContext>
  extends Omit<HandrailChatProps<TRequest>, "runtime" | "composer" | "conversationPicker"> {
  readonly workspace: ConversationWorkspaceController<TRequest, TAuthorizationContext>;
  readonly composerForConversation: (
    runtime: ConversationRuntime<TRequest>,
    conversationId: ConversationId,
  ) => UseConversationComposerOptions<TRequest>;
  readonly createConversation?: () => Promise<ConversationWorkspaceOpenInput<TAuthorizationContext>>;
  readonly conversationPicker?: ReactNode;
  /** Enables full authorized catalog hydration plus archive/restore UI. */
  readonly catalogOptions?: ConversationCatalogWorkspaceOptions<TAuthorizationContext>;
  readonly getThreadLabel?: (conversationId: ConversationId) => ReactNode;
  readonly noConversation?: ReactNode;
  /** Optional stable controller factory, normally `client.presenceControllerFor`. */
  readonly presenceForConversation?: (conversationId: ConversationId) => PresenceController | null;
}

/** Complete selected-runtime binding for concurrent background conversations. */
export function HandrailChatWorkspace<TRequest, TAuthorizationContext>(
  props: HandrailChatWorkspaceProps<TRequest, TAuthorizationContext>,
): ReactNode {
  const snapshot = useConversationWorkspaceSnapshot(props.workspace);
  const selected = snapshot.threads.find((thread) =>
    thread.conversationId === snapshot.selectedConversationId);
  const picker = props.conversationPicker ?? (props.catalogOptions
    ? <CatalogWorkspaceThreadPicker workspace={props.workspace} catalogOptions={props.catalogOptions}
      {...(props.createConversation ? { createConversation: props.createConversation } : {})}
      {...(props.getThreadLabel ? { getThreadLabel: props.getThreadLabel } : {})}/>
    : <WorkspaceThreadPicker workspace={props.workspace}
    {...(props.createConversation ? { createConversation: props.createConversation } : {})}
    {...(props.getThreadLabel ? { getThreadLabel: props.getThreadLabel } : {})}/>);
  if (!selected) return <section className={["hr-chat", props.className].filter(Boolean).join(" ")}
    data-layout={props.layout ?? "page"} style={props.style}>
    <header className="hr-chat__header"><h2>{props.title ?? "Assistant"}</h2>
      <div className="hr-chat__picker">{picker}</div></header>
    <div className="hr-chat__empty">{props.noConversation ?? "Start or select a conversation."}</div>
  </section>;
  const { workspace: _workspace, composerForConversation: _composerFor, createConversation: _create,
    getThreadLabel: _label, noConversation: _empty, conversationPicker: _picker,
    presenceForConversation: _presenceFor, catalogOptions: _catalogOptions, ...chat } = props;
  void _workspace; void _composerFor; void _create; void _label; void _empty; void _picker; void _presenceFor; void _catalogOptions;
  const runtime = selected.runtime as ConversationRuntime<TRequest>;
  const presence = props.presenceForConversation?.(selected.conversationId) ?? props.presence;
  const composer = props.composerForConversation(runtime, selected.conversationId);
  return <HandrailChat {...chat} key={selected.conversationId} runtime={runtime}
    composer={presence && composer.presence === undefined ? { ...composer, presence } : composer}
    {...(presence ? { presence } : {})} conversationPicker={picker}/>;
}

export interface HandrailChatWorkspaceLauncherProps<TRequest, TAuthorizationContext>
  extends HandrailChatWorkspaceProps<TRequest, TAuthorizationContext> {
  readonly trigger?: ReactNode;
  readonly connectionStatus?: ChatLauncherConnectionStatus;
  readonly activity?: ConversationActivityReadable;
}

/** Drop-in launcher whose button reflects every open background conversation. */
export function HandrailChatWorkspaceLauncher<TRequest, TAuthorizationContext>(
  props: HandrailChatWorkspaceLauncherProps<TRequest, TAuthorizationContext>,
): ReactNode {
  const binding = useConversationLauncherBinding(props.workspace, props.connectionStatus, props.activity);
  const { trigger, connectionStatus: _connection, activity: _activity, ...workspaceProps } = props;
  void _connection; void _activity;
  return <ChatLauncherRoot {...binding}><ChatLauncherTrigger className="hr-chat__launcher-trigger">
    {trigger ?? "Open chat"}<ChatLauncherStatus className="hr-chat__launcher-status">{(state) =>
      state.error ? "Error" : state.busy ? "Running" : state.unreadCount > 0 ? "Done" : ""
    }</ChatLauncherStatus><ChatLauncherBadge className="hr-chat__launcher-badge">{(state) =>
      state.unreadCount > 0 ? state.unreadCount : null
    }</ChatLauncherBadge>
  </ChatLauncherTrigger><ChatLauncherPortal><ChatLauncherPanel>
    <ChatLauncherTitle className="hr-chat__sr">{props.title ?? "Assistant"}</ChatLauncherTitle>
    <HandrailChatWorkspace {...workspaceProps} layout="launcher"/>
  </ChatLauncherPanel></ChatLauncherPortal></ChatLauncherRoot>;
}

export interface HandrailAssistantLauncherProps extends Omit<HandrailChatWorkspaceLauncherProps<ChatRequest, object>,
  "workspace" | "composerForConversation" | "createConversation" | "activity" | "presenceForConversation"> {
  /** The only required integration value; capabilities and resources are negotiated from this endpoint. */
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly protectedRequest?: (input: RequestInit & { readonly url: string }) => RequestInit | Promise<RequestInit>;
  /** Receives safe lifecycle diagnostics from browser transports and controllers. */
  readonly diagnostics?: AiDiagnosticSink;
  readonly clientId?: string;
  readonly deviceId?: string;
  readonly loading?: ReactNode;
  readonly failure?: (error: unknown) => ReactNode;
  readonly onWorkingChange?: (working: boolean) => void;
  /** Generate and persist a bounded title after a conversation's first completed turn. Defaults to true. */
  readonly autoTitle?: boolean;
  /** Render the endpoint-driven workspace directly when the host already owns the surrounding shell. */
  readonly presentation?: "launcher" | "page";
  /** Migration/domain seam for an existing authorized upload route. The SDK uploader remains the default. */
  readonly uploaderForConversation?: (conversationId: ConversationId) => AttachmentUploader<Blob>;
  /** Inject the canonical scoped preset once with the launcher. Defaults to true. */
  readonly includeStyles?: boolean;
}

interface AssistantLauncherState {
  readonly client: HandrailAiClient<StreamEvent, ChatRequest, object>;
  readonly uploader: AttachmentUploader<ApplicationGatewayAttachmentSource>;
}

function AssistantWorkingObserver({ workspace, onChange }: {
  readonly workspace: ConversationWorkspaceReadable;
  readonly onChange?: (working: boolean) => void;
}) {
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  useEffect(() => onChange?.(snapshot.runningCount > 0), [onChange, snapshot.runningCount]);
  return null;
}

/** Shared first-turn title QoL; failures are diagnostic-only and never block chat. */
export function StandardConversationTitleObserver({ client, enabled = true, onTitle, diagnostics }: {
  readonly client: HandrailAiClient<StreamEvent, ChatRequest, object>;
  readonly enabled?: boolean;
  readonly onTitle?: (conversationId: ConversationId, title: string) => void;
  readonly diagnostics?: AiDiagnosticSink;
}) {
  const snapshot = useConversationWorkspaceSnapshot(client.workspace!);
  const settled = useRef(new Set<ConversationId>());
  const pending = useRef(new Set<ConversationId>());
  useEffect(() => {
    if (!enabled || !client.catalog.capabilities.rename.supported) return;
    for (const thread of snapshot.threads) {
      const conversationId = thread.conversationId;
      if (thread.turnStatus !== "completed" || settled.current.has(conversationId) ||
          pending.current.has(conversationId)) continue;
      pending.current.add(conversationId);
      void (async () => {
        try {
          const found = await client.catalog.get({ authorizationContext: EMPTY_ASSISTANT_AUTHORIZATION_CONTEXT,
            conversationId });
          if (found.descriptor.title !== null) {
            settled.current.add(conversationId);
            onTitle?.(conversationId, found.descriptor.title);
            return;
          }
          const token = String(conversationId).replaceAll(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 96);
          const generated = await client.resources.generateTitle({ conversationId,
            idempotencyKey: `assistant-title-v1-${token}` });
          const renamed = await client.catalog.rename({
            authorizationContext: EMPTY_ASSISTANT_AUTHORIZATION_CONTEXT,
            conversationId,
            expectedVersion: found.descriptor.version,
            idempotencyKey: `assistant-rename-v1-${token}` as never,
            title: generated,
          });
          settled.current.add(conversationId);
          onTitle?.(conversationId, renamed.descriptor.title ?? generated);
        } catch (cause) {
          emitAiDiagnostic(diagnostics, { domain: "gateway", operation: "automatic_title",
            phase: "failed", retryable: true, conversationId, cause });
        } finally {
          pending.current.delete(conversationId);
        }
      })();
    }
  }, [client, diagnostics, enabled, onTitle, snapshot.threads]);
  return null;
}

/** Default bounded approval review used by the endpoint-only launcher. */
export function StandardGatewayApprovals({ client }: { readonly client: HandrailAiClient<StreamEvent, ChatRequest, object> }) {
  const snapshot = useConversationWorkspaceSnapshot(client.workspace!);
  const conversationId = snapshot.selectedConversationId;
  const [proposals, setProposals] = useState<readonly ConversationApprovalProposalRecord[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    if (conversationId === null) return setProposals([]);
    try {
      setProposals(await client.resources.listApprovalGroup({ groupId: conversationId as never }));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client.resources, conversationId]);
  useEffect(() => {
    void load();
    const timer = globalThis.setInterval(() => void load(), 2_000);
    return () => globalThis.clearInterval(timer);
  }, [load]);
  const decide = async (proposal: ConversationApprovalProposalRecord, status: "confirmed" | "rejected") => {
    if (conversationId === null || busy !== null) return;
    const identity = `assistant:${proposal.proposal_id}:${proposal.proposal_version}:${status}`;
    setBusy(proposal.proposal_id);
    try {
      await client.resources.transitionApproval({ conversationId, proposalId: proposal.proposal_id,
        expectedVersion: proposal.proposal_version, status, idempotencyKey: identity,
        idempotencyFingerprint: identity });
      await load();
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  const pending = proposals.filter((proposal) => proposal.status === "pending");
  if (pending.length === 0 && !failed) return null;
  return <section className="hr-chat__approvals" aria-label="Assistant approvals">
    {failed ? <span className="hr-chat__approval-error" role="alert">Approvals could not be refreshed.</span> : null}
    {pending.map((proposal) => <article className="hr-chat__approval" key={proposal.proposal_id}>
      <strong>{proposal.tool_name.replaceAll("_", " ")}</strong>
      <span>This action requires your confirmation.</span>
      <div className="hr-chat__approval-actions">
        <button disabled={busy !== null} onClick={() => void decide(proposal, "confirmed")}>Confirm</button>
        <button disabled={busy !== null} onClick={() => void decide(proposal, "rejected")}>Reject</button>
      </div>
    </article>)}
  </section>;
}

const EMPTY_ASSISTANT_AUTHORIZATION_CONTEXT = Object.freeze({});

function browserIdentity(prefix: string): string {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

/** Endpoint-only production launcher. It owns negotiation, catalog, runtimes, uploads, recovery, and cleanup. */
export function HandrailAssistantLauncher(props: HandrailAssistantLauncherProps): ReactNode {
  const [state, setState] = useState<AssistantLauncherState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [generatedTitles, setGeneratedTitles] = useState<ReadonlyMap<ConversationId, string>>(new Map());
  const rememberGeneratedTitle = useCallback((conversationId: ConversationId, title: string) => {
    setGeneratedTitles((current) => new Map(current).set(conversationId, title));
  }, []);
  const hostUploaders = useRef(new Map<ConversationId, AttachmentUploader<Blob>>());
  useEffect(() => () => {
    for (const uploader of hostUploaders.current.values()) uploader.dispose();
    hostUploaders.current.clear();
  }, []);
  useEffect(() => {
    let disposed = false;
    let owned: AssistantLauncherState | null = null;
    void (async () => {
      try {
        const authorizationContext = EMPTY_ASSISTANT_AUTHORIZATION_CONTEXT;
        const clientId = (props.clientId ?? browserIdentity("client")) as ConversationClientId;
        const deviceId = (props.deviceId ?? browserIdentity("device")) as ConversationDeviceId;
        const client = await createHandrailAiClient<StreamEvent, ChatRequest, object>({
          baseUrl: props.endpoint,
          ...(props.fetch === undefined ? {} : { fetch: props.fetch }),
          ...(props.protectedRequest === undefined ? {} : { protectedRequest: props.protectedRequest }),
          ...(props.diagnostics === undefined ? {} : { diagnostics: props.diagnostics }),
          conversations: { mode: "multiple", clientId, deviceId, authorize: () => "allow" },
          buildRequest: ({ content, attachments }) => ({
            protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
            continuation_of: null,
            messages: [{ role: "user", content: [
              ...(content ? [{ type: "text" as const, text: content }] : []),
              ...attachments.map((attachment) => ({
                type: String((attachment as { media_type?: string }).media_type).startsWith("image/")
                  ? "image" as const : "document" as const,
                attachment: attachment as never,
              })),
            ] }],
            tools: [], tool_results: [],
            generation: { max_output_tokens: 2048, temperature: 0.2 },
            correlation_hints: {},
          }),
        });
        if (!client.workspace) throw new TypeError("The assistant endpoint did not create a conversation workspace");
        const uploader = createAttachmentUploader<ApplicationGatewayAttachmentSource>(client.attachmentUpload ?? {
          upload: async () => { throw new TypeError("This assistant does not accept attachments"); },
        });
        owned = { client, uploader };
        const listed = await client.catalog.list({ authorizationContext, lifecycle: "active", pageSize: 1,
          order: { field: "updated_at", direction: "desc" } });
        const descriptor = listed.items[0] ?? (await client.catalog.create({ authorizationContext,
          idempotencyKey: browserIdentity("conversation") as never })).descriptor;
        await client.workspace.open({ authorizationContext, conversationId: descriptor.conversationId });
        if (!disposed) setState(owned);
      } catch (cause) { if (!disposed) setError(cause); }
    })();
    return () => {
      disposed = true;
      owned?.uploader.dispose();
      void owned?.client.dispose();
    };
  }, [props.endpoint, props.fetch, props.protectedRequest, props.diagnostics, props.clientId, props.deviceId]);

  const styles = props.includeStyles === false ? null : <StyledChatPresetStyles/>;
  if (error !== null) return <>{styles}{props.failure?.(error) ?? <span role="alert">Assistant unavailable.</span>}</>;
  if (state === null || state.client.workspace === null) return <>{styles}{props.loading ?? null}</>;
  const { endpoint: _endpoint, fetch: _fetch, protectedRequest: _protected, diagnostics: _diagnostics, clientId: _clientId,
    deviceId: _deviceId, loading: _loading, failure: _failure, includeStyles: _includeStyles,
    onWorkingChange: _onWorkingChange, autoTitle: _autoTitle,
    presentation: _presentation, uploaderForConversation: _uploaderForConversation, ...launcher } = props;
  void _endpoint; void _fetch; void _protected; void _diagnostics; void _clientId; void _deviceId; void _loading;
  void _failure; void _includeStyles; void _onWorkingChange; void _autoTitle; void _presentation; void _uploaderForConversation;
  const authorizationContext = EMPTY_ASSISTANT_AUTHORIZATION_CONTEXT;
  const approvals = props.approvals === undefined
    ? <StandardGatewayApprovals client={state.client}/>
    : props.approvals;
  const workspaceProps = {
    ...launcher,
    workspace: state.client.workspace,
    ...(state.client.activity === null ? {} : { activity: state.client.activity }),
    catalogOptions: { catalog: state.client.catalog, authorizationContext },
    getThreadLabel: (conversationId: ConversationId) => generatedTitles.get(conversationId)
      ?? props.getThreadLabel?.(conversationId),
    presenceForConversation: state.client.presenceControllerFor,
    createConversation: async () => {
      const created = await state.client.catalog.create({ authorizationContext,
        idempotencyKey: browserIdentity("conversation") as never });
      return { authorizationContext, conversationId: created.descriptor.conversationId };
    },
    composerForConversation: (runtime: ConversationRuntime<ChatRequest>, conversationId: ConversationId) => ({
      uploader: props.uploaderForConversation === undefined ? state.uploader
        : hostUploaders.current.get(conversationId) ?? (() => {
            const uploader = props.uploaderForConversation!(conversationId);
            hostUploaders.current.set(conversationId, uploader);
            return uploader;
          })(),
      conversationId,
      createRequest: ({ text, attachments }) => state.client.buildRequest({ content: text, attachments }),
    }),
    approvals,
  } satisfies HandrailChatWorkspaceProps<ChatRequest, object>;
  const workspace = props.presentation === "page"
    ? <HandrailChatWorkspace {...workspaceProps} layout="page"/>
    : <HandrailChatWorkspaceLauncher {...workspaceProps}/>;
  return <>{styles}<AssistantWorkingObserver workspace={state.client.workspace}
    {...(props.onWorkingChange === undefined ? {} : { onChange: props.onWorkingChange })}/>
    <StandardConversationTitleObserver client={state.client} enabled={props.autoTitle !== false}
      onTitle={rememberGeneratedTitle}
      {...(props.diagnostics === undefined ? {} : { diagnostics: props.diagnostics })}/>{workspace}</>;
}

export interface StyledChatLauncherProps extends StyledChatPresetProps {
  readonly trigger?: ReactNode;
  readonly workspace?: ConversationWorkspaceReadable;
  readonly connectionStatus?: ChatLauncherConnectionStatus;
  readonly activity?: ConversationActivityReadable;
}

export function StyledChatLauncher(props: StyledChatLauncherProps): ReactNode {
  const binding = useConversationLauncherBinding(props.workspace, props.connectionStatus, props.activity);
  const { workspace: _workspace, connectionStatus: _connectionStatus, activity: _activity,
    trigger, ...preset } = props;
  void _workspace; void _connectionStatus; void _activity;
  return <ChatLauncherRoot {...binding}><ChatLauncherTrigger className="hr-chat__launcher-trigger">
    {trigger ?? "Open chat"}<ChatLauncherStatus className="hr-chat__launcher-status">{(state) =>
      state.error ? "Error" : state.busy ? "Running" : state.unreadCount > 0 ? "Done" : ""
    }</ChatLauncherStatus><ChatLauncherBadge className="hr-chat__launcher-badge">{(state) =>
      state.unreadCount > 0 ? state.unreadCount : null
    }</ChatLauncherBadge>
  </ChatLauncherTrigger>
    <ChatLauncherPortal><ChatLauncherPanel><ChatLauncherTitle className="hr-chat__sr">{props.title ?? "Assistant"}</ChatLauncherTitle>
      <StyledChatPreset {...preset} layout="launcher"/></ChatLauncherPanel></ChatLauncherPortal>
  </ChatLauncherRoot>;
}

export function StyledChatDialog(props: StyledChatPresetProps & { readonly trigger: ReactNode; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }): ReactNode {
  return <ChatDialogRoot open={props.open} onOpenChange={props.onOpenChange}><ChatDialogTrigger>{props.trigger}</ChatDialogTrigger><ChatDialogPortal>
    <ChatDialogOverlay className="hr-chat__overlay"/><ChatDialogContent><StyledChatPreset {...props} layout="dialog"/></ChatDialogContent>
  </ChatDialogPortal></ChatDialogRoot>;
}

export function StyledChatDrawer(props: StyledChatPresetProps & { readonly trigger: ReactNode; readonly side?: ChatDrawerSide; readonly open: boolean; readonly onOpenChange: (open: boolean) => void }): ReactNode {
  return <ChatDrawerRoot open={props.open} onOpenChange={props.onOpenChange} side={props.side ?? "end"}><ChatDrawerTrigger>{props.trigger}</ChatDrawerTrigger><ChatDrawerPortal>
    <ChatDrawerOverlay className="hr-chat__overlay"/><ChatDrawerContent><StyledChatPreset {...props} layout="drawer"/></ChatDrawerContent>
  </ChatDrawerPortal></ChatDrawerRoot>;
}
