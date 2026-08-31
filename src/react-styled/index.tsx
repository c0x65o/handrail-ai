import { type CSSProperties, type ReactNode } from "react";
import type { ConversationState, ConversationToolResultRecord } from "../conversation/state.js";
import type { PresenceController } from "../presence/controller.js";
import type { ToolResultRenderer } from "../react/primitives.js";
import { ConversationProvider } from "../react/context.js";
import { useConversationComposer, type ConversationComposerResult, type UseConversationComposerOptions } from "../react/use-conversation-composer.js";
import type { ConversationRuntime } from "../runtime.js";
import {
  AttachmentList, ChatRoot, Composer, ErrorList, FileInput, Form, LiveRegion,
  Retry, Stop, StreamStatus, Submit, Textarea, Transcript, TypingIndicator,
} from "../react/primitives.js";
import { ChatLauncherPanel, ChatLauncherPortal, ChatLauncherRoot, ChatLauncherTrigger } from "../react/launcher.js";
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

export function installToolRendererPlugins(plugins: readonly ToolRendererPlugin[]): {
  readonly renderers: ToolResultRendererRegistry;
  readonly toolRendererKeys: Readonly<Record<string, string>>;
} {
  const renderers: Record<string, ToolResultRendererRegistry[string]> = {};
  const toolRendererKeys: Record<string, string> = {};
  const identities = new Set<string>();
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
      if (toolRendererKeys[toolName]) throw new TypeError(`Duplicate renderer mapping for "${toolName}"`);
      toolRendererKeys[toolName] = key;
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
}

const DEFAULT_LABELS = { attach: "Attach", send: "Send", stop: "Stop", retry: "Retry", placeholder: "Message…" };

/** A zero-runtime-dependency stylesheet; copy or override every custom property. */
export const handrailChatPresetCss = `
.hr-chat{--hr-accent:#635bff;--hr-bg:#fff;--hr-panel:#f6f7fb;--hr-text:#171927;--hr-muted:#687083;--hr-border:#dfe3eb;color:var(--hr-text);background:var(--hr-bg);border:1px solid var(--hr-border);border-radius:16px;display:grid;grid-template-rows:auto minmax(12rem,1fr) auto;inline-size:min(100%,48rem);block-size:min(80dvh,48rem);font:400 14px/1.5 ui-sans-serif,system-ui,sans-serif;overflow:hidden;box-shadow:0 16px 50px #17192720}
.hr-chat[data-layout=page]{inline-size:100%;block-size:100dvh;border:0;border-radius:0}.hr-chat[data-layout=drawer]{border-radius:16px 0 0 16px;max-inline-size:30rem}.hr-chat__header{align-items:center;border-block-end:1px solid var(--hr-border);display:flex;gap:.75rem;padding:.85rem 1rem}.hr-chat__header h2{font-size:1rem;margin:0}.hr-chat__picker{margin-inline-start:auto}.hr-chat__body{display:grid;grid-template-columns:minmax(0,1fr);min-block-size:0}.hr-chat__transcript{overflow:auto;padding:1rem;scrollbar-gutter:stable}.hr-chat [role=listitem]{background:var(--hr-panel);border-radius:12px;margin:.5rem 0;max-inline-size:85%;padding:.7rem .85rem;white-space:pre-wrap}.hr-chat [aria-label='user message']{background:var(--hr-accent);color:white;margin-inline-start:auto}.hr-chat__status{align-items:center;color:var(--hr-muted);display:flex;gap:.75rem;min-block-size:1.5rem;padding-inline:1rem}.hr-chat__composer{border-block-start:1px solid var(--hr-border);padding:.75rem}.hr-chat__attachments{display:flex;gap:.5rem;list-style:none;margin:0 0 .5rem;padding:0}.hr-chat__form{display:grid;gap:.5rem;grid-template-columns:auto minmax(0,1fr) auto auto}.hr-chat textarea{background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:10px;color:inherit;min-block-size:2.75rem;padding:.65rem;resize:none}.hr-chat button,.hr-chat__file{align-items:center;background:var(--hr-panel);border:1px solid var(--hr-border);border-radius:9px;color:inherit;cursor:pointer;display:inline-flex;padding:.6rem .75rem}.hr-chat button[type=submit]{background:var(--hr-accent);color:#fff}.hr-chat button:focus-visible,.hr-chat textarea:focus-visible,.hr-chat input:focus-visible{outline:3px solid color-mix(in srgb,var(--hr-accent),transparent 55%);outline-offset:2px}.hr-chat button:disabled{cursor:not-allowed;opacity:.5}.hr-chat__errors{color:#a32020;grid-column:1/-1}.hr-chat__aux{border-block-start:1px solid var(--hr-border);padding:.75rem 1rem}@media(max-width:520px){.hr-chat{block-size:100dvh;border:0;border-radius:0;inline-size:100%}.hr-chat__form{grid-template-columns:auto minmax(0,1fr) auto}.hr-chat__retry{display:none}}@media(prefers-reduced-motion:reduce){.hr-chat *{scroll-behavior:auto!important;transition:none!important}}
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
      <Transcript className="hr-chat__transcript" {...(renderToolResult ? { renderToolResult } : {})}>{props.emptyState}</Transcript>
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
  const installed = installToolRendererPlugins(props.rendererPlugins ?? []);
  const { runtime: _runtime, rendererPlugins: _plugins, composer: _composer, presence: _presence, ...preset } = props;
  return <StyledChatPreset {...preset} composer={composer} {...(props.presence ? { presence: props.presence } : {})}
    toolRendererKeys={installed.toolRendererKeys} toolResultRenderers={installed.renderers}/>;
}

/** One-component optional UI; pass a headless runtime to retain full host control. */
export function HandrailChat<TRequest>(props: HandrailChatProps<TRequest>): ReactNode {
  return <ConversationProvider runtime={props.runtime}><BoundHandrailChat {...props}/></ConversationProvider>;
}

export function StyledChatLauncher(props: StyledChatPresetProps & { readonly trigger?: ReactNode }): ReactNode {
  return <ChatLauncherRoot><ChatLauncherTrigger className="hr-chat__launcher-trigger">{props.trigger ?? "Open chat"}</ChatLauncherTrigger>
    <ChatLauncherPortal><ChatLauncherPanel><StyledChatPreset {...props} layout="launcher"/></ChatLauncherPanel></ChatLauncherPortal>
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
