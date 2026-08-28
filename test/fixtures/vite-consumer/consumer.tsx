import { createElement } from "react";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  parseChatRequest,
} from "@handrail/ai";
import { IndexedDBConversationEventStore } from "@handrail/ai/browser";
import "@handrail/ai/react";

export {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  IndexedDBConversationEventStore,
  parseChatRequest,
};

export const reactSubpathElement = createElement(
  "span",
  null,
  "@handrail/ai/react resolved",
);
