import { useCallback, useSyncExternalStore } from "react";
import type { ConversationWorkspaceSnapshot } from "../conversation/workspace.js";
import type {
  ChatLauncherConnectionStatus,
  ChatLauncherRootProps,
} from "./launcher.js";

const EMPTY_WORKSPACE_SNAPSHOT: ConversationWorkspaceSnapshot = Object.freeze({
  selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 0,
  threads: Object.freeze([]),
});

export interface ConversationWorkspaceReadable {
  getSnapshot(): ConversationWorkspaceSnapshot;
  subscribe(listener: () => void): () => void;
}

/** Subscribe React to all open threads without coupling runtime ownership to rendering. */
export function useConversationWorkspaceSnapshot(
  workspace?: ConversationWorkspaceReadable,
): ConversationWorkspaceSnapshot {
  const subscribe = useCallback((notify: () => void) =>
    workspace?.subscribe(notify) ?? (() => undefined), [workspace]);
  const snapshot = useCallback(() => workspace?.getSnapshot() ?? EMPTY_WORKSPACE_SNAPSHOT, [workspace]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type ConversationLauncherBinding = Pick<ChatLauncherRootProps,
  "connectionStatus" | "turnStatus" | "unreadCount">;

/** Derive launcher button/badge state from every concurrent conversation. */
export function useConversationLauncherBinding(
  workspace?: ConversationWorkspaceReadable,
  connectionStatus?: ChatLauncherConnectionStatus,
): ConversationLauncherBinding {
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  return Object.freeze({
    ...(connectionStatus === undefined ? {} : { connectionStatus }),
    turnStatus: snapshot.errorCount > 0 ? "error" as const :
      snapshot.runningCount > 0 ? "busy" as const :
        snapshot.unreadCount > 0 ? "completed" as const : "idle" as const,
    unreadCount: snapshot.unreadCount,
  });
}
