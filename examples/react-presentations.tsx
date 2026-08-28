import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";

import {
  AI_RUNTIME_PROTOCOL_VERSION,
  InMemoryConversationEventStore,
  createAttachmentUploader,
  createConversationRuntime,
  type AttachmentUploader,
  type AuthoritativeAttribution,
  type CancelTurnInput,
  type ChatRequest,
  type ConversationClientId,
  type ConversationId,
  type ConversationRuntime,
  type ConversationRuntimeIdKind,
  type ConversationTransport,
  type PresenceParticipantSummary,
  type StreamEvent,
  type TransportResult,
  type TurnHandle,
  type TurnObservation,
  type TurnObservationResult,
  type TurnResumePoint,
} from "@handrail/ai";
import {
  AttachmentList,
  ChatDialogClose,
  ChatDialogContent,
  ChatDialogDescription,
  ChatDialogOverlay,
  ChatDialogPortal,
  ChatDialogRoot,
  ChatDialogTitle,
  ChatDialogTrigger,
  ChatDrawerClose,
  ChatDrawerContent,
  ChatDrawerDescription,
  ChatDrawerOverlay,
  ChatDrawerPortal,
  ChatDrawerRoot,
  ChatDrawerTitle,
  ChatDrawerTrigger,
  ChatLauncherBadge,
  ChatLauncherClose,
  ChatLauncherDescription,
  ChatLauncherPanel,
  ChatLauncherPortal,
  ChatLauncherRoot,
  ChatLauncherStatus,
  ChatLauncherTitle,
  ChatLauncherTrigger,
  ChatRoot,
  ChatTabsContent,
  ChatTabsList,
  ChatTabsRoot,
  ChatTabsTrigger,
  Composer,
  ErrorList,
  FileInput,
  Form,
  LiveRegion,
  PresenceList,
  Retry,
  Stop,
  StreamStatus,
  Submit,
  Textarea,
  Transcript,
  TypingIndicator,
  ConversationProvider,
  useConversationActions,
  useConversationComposer,
  useConversationSelector,
} from "@handrail/ai/react";

export interface ExampleChatRequest {
  readonly text: string;
  readonly attachmentContentRefs: readonly string[];
}

const EMPTY_CHECKPOINT: TurnResumePoint = {
  lastAppliedEventId: null,
  lastAppliedCursor: null,
  lastAppliedRevision: null,
};

const ATTRIBUTION: AuthoritativeAttribution = {
  organization: { id: "example-org", source: "server_derived", trust: "authoritative" },
  project: { id: "example-project", source: "server_derived", trust: "authoritative" },
  service_environment: {
    id: "example",
    source: "server_derived",
    trust: "authoritative",
  },
  known_user: { id: null, source: "server_derived", trust: "authoritative" },
  session: { id: null, source: "server_derived", trust: "authoritative" },
  automation: { id: null, source: "server_derived", trust: "authoritative" },
};

function frame(
  type: StreamEvent["type"],
  requestId: string,
  sequence: number,
  fields: Record<string, unknown> = {},
): StreamEvent {
  return {
    type,
    protocol_version: AI_RUNTIME_PROTOCOL_VERSION,
    request_id: requestId,
    trace_id: `trace-${requestId}`,
    sequence,
    ...fields,
  } as StreamEvent;
}

class ExampleObservation implements TurnObservation<StreamEvent> {
  readonly #events: StreamEvent[];
  readonly #waiters: Array<() => void> = [];
  #closed = false;
  #settled = false;
  #settle!: (result: TurnObservationResult) => void;
  readonly result: Promise<TurnObservationResult>;

  constructor(started: StreamEvent) {
    this.#events = [started];
    this.result = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  readonly events: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<StreamEvent>> => {
        while (this.#events.length === 0 && !this.#closed) {
          await new Promise<void>((resolve) => this.#waiters.push(resolve));
        }
        const event = this.#events.shift();
        return event === undefined
          ? { done: true, value: undefined }
          : { done: false, value: event };
      },
    }),
  };

  complete(requestId: string): void {
    this.finish(
      [
        frame("response.text.delta", requestId, 1, {
          delta: "This deterministic response came from the injected example transport.",
        }),
        frame("response.completed", requestId, 2, { outcome: "stop" }),
      ],
      { status: "completed", checkpoint: EMPTY_CHECKPOINT },
    );
  }

  cancel(requestId: string): void {
    this.finish(
      [frame("response.cancelled", requestId, 1, { reason: "runtime_shutdown" })],
      { status: "cancelled", checkpoint: EMPTY_CHECKPOINT },
    );
  }

  disconnect(): void {
    this.finish([], { status: "disconnected", checkpoint: EMPTY_CHECKPOINT });
  }

  private finish(events: readonly StreamEvent[], result: TurnObservationResult): void {
    if (this.#closed) return;
    this.#events.push(...events);
    this.#closed = true;
    for (const wake of this.#waiters.splice(0)) wake();
    if (!this.#settled) {
      this.#settled = true;
      this.#settle(result);
    }
  }
}

/** Credential-free, deterministic transport used only by these checked recipes. */
export class ReactPresentationTransport
  implements ConversationTransport<StreamEvent, ExampleChatRequest>
{
  readonly cancellationInputs: CancelTurnInput[] = [];
  readonly #observations = new Map<string, ExampleObservation>();
  readonly capabilities: ConversationTransport["capabilities"] = {
    authoritativeCancellation: {
      supported: true,
      capability: {
        cancelTurn: async (input) => {
          this.cancellationInputs.push(input);
          this.#observations.get(input.turnId)?.cancel(input.turnId);
          return {
            ok: true,
            value: { status: "cancellation_requested" },
          } as const;
        },
      },
    },
    attachmentUpload: { supported: false },
    presence: { supported: false },
    synchronization: { supported: false },
  };

  async startTurn(
    input: Parameters<ConversationTransport<StreamEvent, ExampleChatRequest>["startTurn"]>[0],
  ): Promise<TransportResult<TurnHandle<StreamEvent>>> {
    const turnId = `example-${input.idempotencyKey}`;
    const observation = new ExampleObservation(
      frame("response.started", turnId, 0, { attribution: ATTRIBUTION }),
    );
    this.#observations.set(turnId, observation);
    return {
      ok: true,
      value: {
        conversationId: input.conversationId,
        mutationId: input.mutationId,
        turnId,
        observation,
      },
    };
  }

  async resumeTurn(
    input: Parameters<ConversationTransport<StreamEvent>["resumeTurn"]>[0],
  ): Promise<TransportResult<TurnObservation<StreamEvent>>> {
    const observation = this.#observations.get(input.turnId);
    return observation === undefined
      ? {
          ok: false,
          error: { code: "not_found", message: "Example turn not found", retryable: false },
        }
      : { ok: true, value: observation };
  }

  completeActive(): void {
    for (const [turnId, observation] of this.#observations) {
      observation.complete(turnId);
    }
  }
}

export interface ReactPresentationFixture {
  readonly runtime: ConversationRuntime<ExampleChatRequest>;
  readonly transport: ReactPresentationTransport;
  readonly uploader: AttachmentUploader<Blob>;
  dispose(): void;
}

/** One shared headless construction pattern for every presentation below. */
export async function createReactPresentationFixture(): Promise<ReactPresentationFixture> {
  const transport = new ReactPresentationTransport();
  let nextId = 0;
  const createId = (kind: ConversationRuntimeIdKind): string => {
    nextId += 1;
    return `${kind}_react_recipe_${nextId}`;
  };
  const runtime = await createConversationRuntime<ExampleChatRequest>({
    conversationId: "conversation-react-recipe" as ConversationId,
    clientId: "client-react-recipe" as ConversationClientId,
    eventStore: new InMemoryConversationEventStore(),
    transport,
    createId,
    now: () => "2026-08-28T00:00:00.000Z",
  });
  const uploader = createAttachmentUploader<Blob>({
    async upload({ idempotencyKey, metadata }) {
      return {
        attachment_id: `att_${idempotencyKey}`,
        content_ref: `ref_${idempotencyKey}`,
        media_type: metadata.mediaType,
        byte_size: metadata.byteSize,
        ...(metadata.filename === undefined ? {} : { filename: metadata.filename }),
      };
    },
  });
  return {
    runtime,
    transport,
    uploader,
    dispose() {
      uploader.dispose();
      runtime.destroy();
    },
  };
}

export interface ReactPresentationRecipeProps {
  readonly runtime: ConversationRuntime<ExampleChatRequest>;
  readonly uploader: AttachmentUploader<Blob>;
  readonly defaultOpen?: boolean;
}

const PARTICIPANTS = [
  {
    participant_id: "support-agent",
    participant_kind: "known_user",
    state: "active",
    typing: true,
    updated_at: "2026-08-28T00:00:00.000Z",
    record_count: 1,
    records: [],
  } as PresenceParticipantSummary,
] as const;

function useExampleComposer(
  runtime: ConversationRuntime<ExampleChatRequest>,
  uploader: AttachmentUploader<Blob>,
) {
  const stop = useCallback(async () => {
    const turnId = runtime.getSnapshot().active_turn_id;
    if (turnId === null) return;
    await runtime.cancelTurn(turnId, "runtime_shutdown");
  }, [runtime]);
  return useConversationComposer({
    uploader,
    createRequest: ({ attachments, text }) => ({
      text,
      attachmentContentRefs: attachments.map((attachment) => attachment.content_ref),
    }),
    enterBehavior: "send",
    imageIntake: { previews: false },
    onCancel: stop,
  });
}

function ConversationBody({
  className,
  runtime,
  uploader,
}: ReactPresentationRecipeProps & { readonly className: string }) {
  const composer = useExampleComposer(runtime, uploader);
  return (
    <ChatRoot className={className} composer={composer}>
      <Transcript className={`${className}__transcript`} aria-label="Support messages" />
      <div className={`${className}__activity`}>
        <StreamStatus aria-label="Response status" />
        <LiveRegion aria-label="Conversation announcements" />
        <PresenceList
          aria-label="People in this conversation"
          participants={PARTICIPANTS}
          renderParticipant={() => "Support agent online"}
        />
        <TypingIndicator
          aria-label="Typing status"
          participants={PARTICIPANTS}
          getParticipantName={() => "Support agent"}
        />
      </div>
      <Composer className={`${className}__composer`}>
        <AttachmentList aria-label="Pending image attachments" />
        <ErrorList />
        <Form aria-label="Send a support message">
          <label>
            Message
            <Textarea aria-label="Message" placeholder="Write a message" />
          </label>
          <label>
            Add images
            <FileInput aria-label="Attach images" />
          </label>
          <Submit>Send</Submit>
          <Stop>Stop</Stop>
          <Retry available={false}>Retry</Retry>
        </Form>
      </Composer>
    </ChatRoot>
  );
}

function BoundRecipe({
  children,
  runtime,
}: Pick<ReactPresentationRecipeProps, "runtime"> & { readonly children: ReactNode }) {
  return <ConversationProvider runtime={runtime}>{children}</ConversationProvider>;
}

/** Modal recipe. Closing only changes presentation state; Stop owns cancellation. */
export function ChatDialogRecipe({ defaultOpen = true, runtime, uploader }: ReactPresentationRecipeProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <BoundRecipe runtime={runtime}>
      <ChatDialogRoot open={open} onOpenChange={setOpen}>
        <ChatDialogTrigger className="app-chat-dialog__trigger">Open support dialog</ChatDialogTrigger>
        <ChatDialogPortal>
          <ChatDialogOverlay className="app-chat-dialog__overlay" />
          <ChatDialogContent className="app-chat-dialog" aria-label="Support chat dialog">
            <ChatDialogTitle>Support chat</ChatDialogTitle>
            <ChatDialogDescription>Ask a question or attach an image.</ChatDialogDescription>
            <ChatDialogClose aria-label="Close support dialog">Close</ChatDialogClose>
            <ConversationBody className="app-chat-dialog__body" runtime={runtime} uploader={uploader} />
          </ChatDialogContent>
        </ChatDialogPortal>
      </ChatDialogRoot>
    </BoundRecipe>
  );
}

/** Tab-panel recipe. Switching tabs hides, but force-mounts, the active conversation. */
export function ChatTabsRecipe({ runtime, uploader }: ReactPresentationRecipeProps) {
  return (
    <BoundRecipe runtime={runtime}>
      <ChatTabsRoot defaultValue="chat" className="app-chat-tabs">
        <ChatTabsList aria-label="Support workspace">
          <ChatTabsTrigger value="chat">Chat</ChatTabsTrigger>
          <ChatTabsTrigger value="details">Details</ChatTabsTrigger>
        </ChatTabsList>
        <ChatTabsContent value="chat" forceMount className="app-chat-tabs__panel">
          <ConversationBody className="app-chat-tabs__body" runtime={runtime} uploader={uploader} />
        </ChatTabsContent>
        <ChatTabsContent value="details">
          <p>Application-owned support details.</p>
        </ChatTabsContent>
      </ChatTabsRoot>
    </BoundRecipe>
  );
}

/** Drawer recipe. Its side attribute is a styling hook; host CSS owns positioning. */
export function ChatDrawerRecipe({ defaultOpen = true, runtime, uploader }: ReactPresentationRecipeProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <BoundRecipe runtime={runtime}>
      <ChatDrawerRoot open={open} onOpenChange={setOpen} modal={false} side="end">
        <ChatDrawerTrigger className="app-chat-drawer__trigger">Open support drawer</ChatDrawerTrigger>
        <ChatDrawerPortal>
          <ChatDrawerOverlay className="app-chat-drawer__overlay" />
          <ChatDrawerContent className="app-chat-drawer" aria-label="Support chat drawer">
            <ChatDrawerTitle>Support drawer</ChatDrawerTitle>
            <ChatDrawerDescription>Conversation alongside application content.</ChatDrawerDescription>
            <ChatDrawerClose aria-label="Close support drawer">Close</ChatDrawerClose>
            <ConversationBody className="app-chat-drawer__body" runtime={runtime} uploader={uploader} />
          </ChatDrawerContent>
        </ChatDrawerPortal>
      </ChatDrawerRoot>
    </BoundRecipe>
  );
}

/** Floating launcher recipe. The host application owns its placement and responsive CSS. */
export function ChatLauncherRecipe({ defaultOpen = true, runtime, uploader }: ReactPresentationRecipeProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <BoundRecipe runtime={runtime}>
      <ChatLauncherRoot
        open={open}
        onOpenChange={setOpen}
        connectionStatus="connected"
        turnStatus={runtime.getSnapshot().active_turn_id === null ? "idle" : "busy"}
        unreadCount={1}
      >
        <ChatLauncherTrigger className="app-chat-launcher__trigger" aria-label="Open support launcher">
          Support
          <ChatLauncherBadge />
        </ChatLauncherTrigger>
        <ChatLauncherPortal>
          <ChatLauncherPanel className="app-chat-launcher" aria-label="Support launcher panel">
            <ChatLauncherTitle>Support launcher</ChatLauncherTitle>
            <ChatLauncherDescription>Chat without leaving the current page.</ChatLauncherDescription>
            <ChatLauncherStatus aria-label="Launcher status" />
            <ChatLauncherClose aria-label="Close support launcher">Close</ChatLauncherClose>
            <ConversationBody className="app-chat-launcher__body" runtime={runtime} uploader={uploader} />
          </ChatLauncherPanel>
        </ChatLauncherPortal>
      </ChatLauncherRoot>
    </BoundRecipe>
  );
}

/** Full-page recipe composed from core chat primitives and native landmarks. */
export function FullPageChatRecipe({ runtime, uploader }: ReactPresentationRecipeProps) {
  return (
    <BoundRecipe runtime={runtime}>
      <main className="app-chat-page" aria-labelledby="app-chat-page-title">
        <header className="app-chat-page__header">
          <h1 id="app-chat-page-title">Customer support</h1>
        </header>
        <ConversationBody className="app-chat-page__conversation" runtime={runtime} uploader={uploader} />
      </main>
    </BoundRecipe>
  );
}

/** Fully custom native markup: state and behavior come only from public hooks/selectors. */
export function CustomHooksChatRecipe({ runtime, uploader }: ReactPresentationRecipeProps) {
  return (
    <BoundRecipe runtime={runtime}>
      <CustomHooksChat runtime={runtime} uploader={uploader} />
    </BoundRecipe>
  );
}

function CustomHooksChat({ runtime, uploader }: ReactPresentationRecipeProps) {
  const messages = useConversationSelector((state) => state.messages);
  const activeTurnId = useConversationSelector((state) => state.active_turn_id);
  const turns = useConversationSelector((state) => state.turns);
  const actions = useConversationActions<ExampleChatRequest>();
  const composer = useExampleComposer(runtime, uploader);
  const status = useMemo(() => turns.at(-1)?.status ?? "idle", [turns]);
  const submit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void composer.submit(event);
  }, [composer]);
  void actions;

  return (
    <main className="app-custom-chat" aria-labelledby="app-custom-chat-title">
      <h1 id="app-custom-chat-title">Custom support chat</h1>
      <section role="region" aria-label="Custom support messages">
        <ol aria-label="Messages">
          {messages.map((message) => (
            <li key={message.message_id} aria-label={`${message.role ?? "unknown"} message`}>
              {message.content.map((part, index) => (
                <span key={index}>{part.type === "text" ? part.text : "Image attachment"}</span>
              ))}
            </li>
          ))}
        </ol>
      </section>
      <p role="status" aria-live="polite" aria-busy={activeTurnId !== null}>
        Response status: {status}
      </p>
      <div role="status" aria-live="polite" aria-label="Conversation announcements">
        {activeTurnId === null ? "Ready for a message." : "Response in progress."}
      </div>
      <ul aria-label="People in this conversation"><li>Support agent online</li></ul>
      <p role="status" aria-live="polite" aria-label="Typing status">Support agent is typing.</p>
      <ul aria-label="Pending image attachments">
        {composer.attachments.map((attachment) => (
          <li key={attachment.id}>
            {attachment.filename ?? attachment.mediaType}
            <button type="button" onClick={() => composer.removeAttachment(attachment.id)}>
              Remove {attachment.filename ?? "image"}
            </button>
          </li>
        ))}
      </ul>
      <form aria-label="Send a custom support message" onSubmit={submit}>
        <label>
          Message
          <textarea aria-label="Custom message" {...composer.getTextareaProps()} />
        </label>
        <label>
          Add images
          <input type="file" aria-label="Attach custom images" {...composer.getFileInputProps()} />
        </label>
        <button type="submit" disabled={!composer.canSend || composer.isSending}>Send</button>
        <button type="button" disabled={activeTurnId === null} onClick={() => void composer.stop()}>
          Stop
        </button>
        <button type="button" disabled>Retry</button>
      </form>
    </main>
  );
}

/** Useful to consumer fixtures that want to render every recipe with one fixture. */
export const REACT_PRESENTATION_RECIPES = [
  ChatDialogRecipe,
  ChatTabsRecipe,
  ChatDrawerRecipe,
  ChatLauncherRecipe,
  FullPageChatRecipe,
  CustomHooksChatRecipe,
] as const;

// ChatRequest is intentionally imported as a public declaration proof: recipe requests are
// application-specific and need not expose provider credentials or make network calls.
export type CheckedPublicChatRequestDeclaration = ChatRequest;
