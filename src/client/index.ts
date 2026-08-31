/** Cross-platform client entry point: no React, Node, database, or provider dependencies. */
export {
  APPLICATION_GATEWAY_PROTOCOL_VERSION,
  createApplicationGatewayTransport,
  createApplicationGatewayResourceClient,
  negotiateApplicationGatewayCapabilities,
  type ApplicationGatewayCapabilities,
  type ApplicationGatewayAttachmentSource,
  type ApplicationGatewayEventEnvelope,
  type ApplicationGatewayPresenceClient,
  type ApplicationGatewayTransportOptions,
  type ApplicationGatewayResourceClient,
} from "../transports/application-gateway.js";
export type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
  ConversationTransportCapabilities,
  ResumeTurnInput,
  StartTurnInput,
  TransportError,
  TransportResult,
  TurnHandle,
  TurnObservation,
  TurnObservationResult,
  TurnResumePoint,
} from "../transports/types.js";
export {
  LIVE_PRESENCE_PROTOCOL_VERSION,
  type LivePresenceEnvelope,
} from "../presence/live-delivery.js";
export type { PresenceRecord } from "../presence/types.js";
export type { AttachmentReference, ApplicationToolResult, StreamEvent } from "../protocol.js";
export type { CitationSource } from "../citations.js";
export {
  createConversationRuntime,
  type ConversationRuntime,
  type ConversationRuntimeCancellationResult,
  type ConversationRuntimeTurnResult,
} from "../runtime.js";
export {
  InMemoryConversationEventStore,
  type ConversationEventStore,
  type StoredConversationEvent,
} from "../conversation/event-store.js";
export {
  isConversationEvent,
  parseConversationEvent,
  type ConversationEvent,
  type ConversationEventPayload,
} from "../conversation/events.js";
export {
  createInitialConversationState,
  type ConversationState,
} from "../conversation/state.js";
