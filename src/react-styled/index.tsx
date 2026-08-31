import { useState, type CSSProperties, type ReactNode } from "react";
import type { ConversationState, ConversationToolResultRecord } from "../conversation/state.js";
import type { PresenceController } from "../presence/controller.js";
import type { MessageAttachmentRenderer, ToolResultRenderer } from "../react/primitives.js";
import { ConversationProvider } from "../react/context.js";
import { useConversationComposer, type ConversationComposerResult, type UseConversationComposerOptions } from "../react/use-conversation-composer.js";
import type { ConversationRuntime } from "../runtime.js";
import type { ConversationId } from "../conversation/events.js";
import type { ConversationWorkspaceOpenInput } from "../conversation/workspace.js";
import { useConversationLauncherBinding, useConversationWorkspaceSnapshot,
  type ConversationActivityReadable, type ConversationWorkspaceReadable } from "../react/workspace.js";
import type { ChatLauncherConnectionStatus } from "../react/launcher.js";
import {
  AttachmentList, ChatRoot, Composer, ErrorList, FileInput, Form, LiveRegion,
  Message, Retry, Stop, StreamStatus, Submit, Textarea, Transcript, TypingIndicator,
} from "../react/primitives.js";
import { CopyMessageButton } from "../react/message-actions.js";
import { ChatLauncherBadge, ChatLauncherPanel, ChatLauncherPortal, ChatLauncherRoot,
  ChatLauncherStatus, ChatLauncherTitle, ChatLauncherTrigger } from "../react/launcher.js";
import { ChatDialogContent, ChatDialogOverlay, ChatDialogPortal, ChatDialogRoot, ChatDialogTrigger } from "../react/dialog.js";
import { ChatDrawerContent, ChatDrawerOverlay, ChatDrawerPortal, ChatDrawerRoot, ChatDrawerTrigger, type ChatDrawerSide } from "../react/drawer.js";

export const HANDRAIL_CHAT_PRESET_VERSION = "handrail.react-preset.v1" as const;

export type StyledChatLayout = "launcher" | "dialog" | "drawer" | "page";

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
  /** Enabled by default; disable when the host renders its own message actions. */
  readonly messageActions?: boolean;
  readonly renderMessageAttachment?: MessageAttachmentRenderer;
  readonly toolRendererKeys?: Readonly<Record<string, string>>;
  readonly toolResultRenderers?: ToolResultRendererRegistry;
  readonly className?: string;
  readonly style?: CSSProperties;
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
.hr-chat{--hr-accent:#635bff;--hr-bg:#fff;--hr-panel:#f6f7fb;--hr-text:#171927;--hr-muted:#687083;--hr-border:#dfe3eb;color:var(--hr-text);background:var(--hr-bg);border:1px solid var(--hr-border);border-radius:16px;display:grid;grid-template-rows:auto minmax(12rem,1fr) auto;inline-size:min(100%,48rem);block-size:min(80dvh,48rem);font:400 14px/1.5 ui-sans-serif,system-ui,sans-serif;overflow:hidden;box-shadow:0 16px 50px #17192720}
.hr-chat[data-layout=page]{inline-size:100%;block-size:100dvh;border:0;border-radius:0}.hr-chat[data-layout=drawer]{border-radius:16px 0 0 16px;max-inline-size:30rem}.hr-chat__sr{block-size:1px;clip:rect(0 0 0 0);clip-path:inset(50%);inline-size:1px;overflow:hidden;position:absolute;white-space:nowrap}.hr-chat__header{align-items:center;border-block-end:1px solid var(--hr-border);display:flex;gap:.75rem;padding:.85rem 1rem}.hr-chat__header h2{font-size:1rem;margin:0}.hr-chat__picker{margin-inline-start:auto}.hr-chat__body{display:grid;grid-template-columns:minmax(0,1fr);min-block-size:0}.hr-chat__transcript{overflow:auto;padding:1rem;scrollbar-gutter:stable}.hr-chat [role=listitem]{background:var(--hr-panel);border-radius:12px;margin:.5rem 0;max-inline-size:85%;padding:.7rem .85rem;white-space:pre-wrap}.hr-chat [aria-label='user message']{background:var(--hr-accent);color:white;margin-inline-start:auto}.hr-chat__message-actions{display:flex;justify-content:flex-end;margin-block-start:.25rem}.hr-chat__message-actions button{font-size:.75rem;padding:.25rem .45rem}.hr-message-action-status:not(:empty){margin-inline-start:.4rem}.hr-chat__status{align-items:center;color:var(--hr-muted);display:flex;gap:.75rem;min-block-size:1.5rem;padding-inline:1rem}.hr-chat__composer{border-block-start:1px solid var(--hr-border);padding:.75rem}.hr-chat__attachments{display:flex;gap:.5rem;list-style:none;margin:0 0 .5rem;padding:0}.hr-chat__form{display:grid;gap:.5rem;grid-template-columns:auto minmax(0,1fr) auto auto}.hr-chat textarea{background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:10px;color:inherit;min-block-size:2.75rem;padding:.65rem;resize:none}.hr-chat button,.hr-chat__file{align-items:center;background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:9px;color:inherit;cursor:pointer;display:inline-flex;padding:.6rem .75rem}.hr-chat button[type=submit]{background:var(--hr-accent);color:#fff}.hr-chat button:focus-visible,.hr-chat textarea:focus-visible,.hr-chat input:focus-visible{outline:3px solid color-mix(in srgb,var(--hr-accent),transparent 55%);outline-offset:2px}.hr-chat button:disabled{cursor:not-allowed;opacity:.5}.hr-chat__errors{color:#a32020;grid-column:1/-1}.hr-chat__aux{border-block-start:1px solid var(--hr-border);padding:.75rem 1rem}@media(max-width:520px){.hr-chat{block-size:100dvh;border:0;border-radius:0;inline-size:100%}.hr-chat__form{grid-template-columns:auto minmax(0,1fr) auto}.hr-chat__retry{display:none}}@media(prefers-reduced-motion:reduce){.hr-chat *{scroll-behavior:auto!important;transition:none!important}}
.hr-chat__launcher-trigger{align-items:center;display:inline-flex;gap:.45rem}.hr-chat__launcher-status{font-size:.75rem;font-weight:600}.hr-chat__launcher-trigger[data-busy=true] .hr-chat__launcher-status{color:#6750a4}.hr-chat__launcher-trigger[data-error=true] .hr-chat__launcher-status{color:#a32020}.hr-chat__launcher-badge:empty{display:none}.hr-chat__launcher-badge{align-items:center;background:#a32020;border-radius:999px;color:#fff;display:inline-flex;font-size:.7rem;justify-content:center;min-block-size:1.2rem;min-inline-size:1.2rem;padding-inline:.25rem}
.hr-chat__workspace-picker{align-items:flex-start;display:flex;gap:.4rem;position:relative}.hr-chat__workspace-picker summary{background:var(--hr-panel,#f6f7fb);border:1px solid var(--hr-border,#dfe3eb);border-radius:9px;cursor:pointer;list-style:none;padding:.6rem .75rem}.hr-chat__workspace-picker summary::-webkit-details-marker{display:none}.hr-chat__workspace-picker ul{background:var(--hr-bg,#fff);border:1px solid var(--hr-border,#dfe3eb);display:grid;gap:.25rem;inset-block-start:100%;inset-inline-end:0;list-style:none;margin:0;max-block-size:16rem;min-inline-size:14rem;overflow:auto;padding:.35rem;position:absolute;z-index:10}.hr-chat__workspace-picker li{margin:0;padding:0}.hr-chat__workspace-picker li button{align-items:center;display:flex;inline-size:100%;justify-content:space-between;max-inline-size:none;text-align:start}.hr-chat__workspace-picker small{color:var(--hr-muted,#687083);margin-inline-start:.5rem}.hr-chat__workspace-picker [data-turn-status=running] small{color:#6750a4}.hr-chat__empty{display:grid;min-block-size:12rem;place-items:center;padding:1rem}
`;

export function StyledChatPresetStyles(): ReactNode {
  return <style data-handrail-ai-preset={HANDRAIL_CHAT_PRESET_VERSION}>{handrailChatPresetCss}</style>;
}

/** Accessible responsive drop-in surface; all headless primitives remain independently usable. */
export function StyledChatPreset(props: StyledChatPresetProps): ReactNode {
  const labels = { ...DEFAULT_LABELS, ...props.labels };
  const renderToolResult: ToolResultRenderer | undefined = props.toolResultRenderers ? (result, toolCall) => {
    const key = props.toolRendererKeys?.[toolCall.name ?? ""];
    const renderer = key ? props.toolResultRenderers?.[key] : undefined;
    return renderer ? renderer(result) : <pre>{JSON.stringify(result.content, null, 2)}</pre>;
  } : undefined;
  return <ChatRoot
    className={["hr-chat", props.className].filter(Boolean).join(" ")}
    data-layout={props.layout ?? "page"}
    style={props.style}
    {...(props.composer ? { composer: props.composer } : {})}
    {...(props.state ? { state: props.state } : {})}
    {...(props.presence ? { presence: props.presence } : {})}
  >
    <header className="hr-chat__header"><h2>{props.title ?? "Assistant"}</h2>{props.conversationPicker && <div className="hr-chat__picker">{props.conversationPicker}</div>}</header>
    <main className="hr-chat__body">
      <Transcript className="hr-chat__transcript" {...(renderToolResult ? { renderToolResult } : {})}
        {...(props.renderMessageAttachment ? { renderAttachment: props.renderMessageAttachment } : {})}
        {...(props.messageActions === false ? {} : { renderMessage: (message, _index, context) => <div>
          <Message message={message} error={context.error} toolCalls={context.toolCalls}
            {...(props.renderMessageAttachment ? { renderAttachment: props.renderMessageAttachment } : {})}
            {...(renderToolResult ? { renderToolResult } : {})}/>
          <div className="hr-chat__message-actions"><CopyMessageButton message={message}/></div>
        </div> })}>{props.emptyState}</Transcript>
      <div className="hr-chat__status"><StreamStatus/><TypingIndicator/></div>
      <LiveRegion/>
    </main>
    {(props.approvals || props.citations) && <aside className="hr-chat__aux">{props.approvals}{props.citations}</aside>}
    <Composer className="hr-chat__composer">
      <AttachmentList className="hr-chat__attachments"/>
      <Form className="hr-chat__form">
        <label className="hr-chat__file">{labels.attach}<FileInput hidden/></label>
        <Textarea rows={1} placeholder={labels.placeholder}/>
        <Stop>{labels.stop}</Stop><Retry className="hr-chat__retry">{labels.retry}</Retry>
        <Submit>{labels.send}</Submit><ErrorList className="hr-chat__errors"/>
      </Form>
    </Composer>
    {props.footer}
  </ChatRoot>;
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

export interface HandrailChatWorkspaceProps<TRequest, TAuthorizationContext>
  extends Omit<HandrailChatProps<TRequest>, "runtime" | "composer" | "conversationPicker"> {
  readonly workspace: ConversationWorkspaceController<TRequest, TAuthorizationContext>;
  readonly composerForConversation: (
    runtime: ConversationRuntime<TRequest>,
    conversationId: ConversationId,
  ) => UseConversationComposerOptions<TRequest>;
  readonly createConversation?: () => Promise<ConversationWorkspaceOpenInput<TAuthorizationContext>>;
  readonly conversationPicker?: ReactNode;
  readonly getThreadLabel?: (conversationId: ConversationId) => ReactNode;
  readonly noConversation?: ReactNode;
}

/** Complete selected-runtime binding for concurrent background conversations. */
export function HandrailChatWorkspace<TRequest, TAuthorizationContext>(
  props: HandrailChatWorkspaceProps<TRequest, TAuthorizationContext>,
): ReactNode {
  const snapshot = useConversationWorkspaceSnapshot(props.workspace);
  const selected = snapshot.threads.find((thread) =>
    thread.conversationId === snapshot.selectedConversationId);
  const picker = props.conversationPicker ?? <WorkspaceThreadPicker workspace={props.workspace}
    {...(props.createConversation ? { createConversation: props.createConversation } : {})}
    {...(props.getThreadLabel ? { getThreadLabel: props.getThreadLabel } : {})}/>;
  if (!selected) return <section className={["hr-chat", props.className].filter(Boolean).join(" ")}
    data-layout={props.layout ?? "page"} style={props.style}>
    <header className="hr-chat__header"><h2>{props.title ?? "Assistant"}</h2>
      <div className="hr-chat__picker">{picker}</div></header>
    <div className="hr-chat__empty">{props.noConversation ?? "Start or select a conversation."}</div>
  </section>;
  const { workspace: _workspace, composerForConversation: _composerFor, createConversation: _create,
    getThreadLabel: _label, noConversation: _empty, conversationPicker: _picker, ...chat } = props;
  void _workspace; void _composerFor; void _create; void _label; void _empty; void _picker;
  const runtime = selected.runtime as ConversationRuntime<TRequest>;
  return <HandrailChat {...chat} key={selected.conversationId} runtime={runtime}
    composer={props.composerForConversation(runtime, selected.conversationId)} conversationPicker={picker}/>;
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
