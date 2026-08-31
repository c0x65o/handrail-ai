/**
 * React bindings with no DOM elements or react-dom dependency.
 *
 * This is the supported React Native and custom-renderer entry point. Native
 * applications own their View/Text/TextInput presentation while sharing the
 * same typed runtime, state selectors, and actions as browser React clients.
 */
export {
  ConversationProvider,
  type ConversationFactoryProviderProps,
  type ConversationProviderFactory,
  type ConversationProviderProps,
  type ConversationReadableStore,
  type ConversationRuntimeProviderProps,
  type ConversationStoreProviderProps,
  type ConversationStoreRuntimeProviderProps,
} from "../react/context.js";
export {
  useConversationActions,
  useConversationSelector,
  useConversationSnapshot,
  useConversationStore,
  type ConversationActions,
} from "../react/hooks.js";
