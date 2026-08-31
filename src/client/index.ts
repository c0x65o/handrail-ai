/** Cross-platform client entry point: no React, Node, database, or provider dependencies. */
export {
  APPLICATION_GATEWAY_PROTOCOL_VERSION,
  createApplicationGatewayTransport,
  createApplicationGatewayResourceClient,
  negotiateApplicationGatewayCapabilities,
  type ApplicationGatewayCapabilities,
  type ApplicationGatewayEventEnvelope,
  type ApplicationGatewayTransportOptions,
  type ApplicationGatewayResourceClient,
} from "../transports/application-gateway.js";
export type {
  AuthoritativeCancelTurnResult,
  CancelTurnInput,
  ConversationTransport,
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
