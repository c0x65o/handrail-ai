import { createElement } from "react";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  parseChatRequest,
} from "@handrail/ai";
import {
  IndexedDBConversationEventStore,
  IndexedDBConversationSyncStateStore,
} from "@handrail/ai/browser";
import "@handrail/ai/react";
import {
  REACT_PRESENTATION_RECIPES,
  createReactPresentationFixture,
  type ReactPresentationRecipeProps,
} from "../../../examples/react-presentations.js";

export {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  IndexedDBConversationEventStore,
  IndexedDBConversationSyncStateStore,
  parseChatRequest,
};

export const reactSubpathElement = createElement(
  "span",
  null,
  "@handrail/ai/react resolved",
);

/** Vite compiles actual elements for all six checked, consumer-owned recipes. */
export function renderReactPresentationRecipes(props: ReactPresentationRecipeProps) {
  return REACT_PRESENTATION_RECIPES.map((Recipe, index) =>
    createElement(Recipe, { ...props, key: index })
  );
}

export { createReactPresentationFixture };
