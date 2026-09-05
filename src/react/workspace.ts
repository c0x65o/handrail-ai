import { useCallback, useSyncExternalStore } from "react";
import { projectConversationActivity } from "../conversation/activity-projection.js";
import type { ConversationWorkspaceSnapshot } from "../conversation/workspace.js";
import type { ConversationActivityReadable, ConversationActivityRecord } from "../conversation/activity.js";
export type { ConversationActivityReadable, ConversationActivityRecord } from "../conversation/activity.js";
import type {
  ChatLauncherConnectionStatus,
  ChatLauncherRootProps,
} from "./launcher.js";

const EMPTY_WORKSPACE_SNAPSHOT: ConversationWorkspaceSnapshot = Object.freeze({
  selectedConversationId: null, runningCount: 0, errorCount: 0, unreadCount: 0,
  threads: Object.freeze([]),
});
const EMPTY_ACTIVITY_SNAPSHOT: readonly ConversationActivityRecord[] = Object.freeze([]);

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
  "activityProgress" | "activitySummary" | "connectionStatus" | "turnStatus" | "unreadCount">;

/** Observe server activity and resolve it against currently open runtimes. */
export function useConversationActivitySnapshot(
  workspace?: ConversationWorkspaceReadable,
  activity?: ConversationActivityReadable,
): readonly ConversationActivityRecord[] {
  const snapshot = useConversationWorkspaceSnapshot(workspace);
  const subscribeActivity = useCallback((notify: () => void) =>
    activity?.subscribe(notify) ?? (() => undefined), [activity]);
  const activitySnapshot = useCallback(() => activity?.getSnapshot() ?? EMPTY_ACTIVITY_SNAPSHOT, [activity]);
  const remote = useSyncExternalStore(subscribeActivity, activitySnapshot, activitySnapshot);
  return projectConversationActivity(snapshot, remote);
}

/** Derive launcher button/badge state from every concurrent conversation. */
export function useConversationLauncherBinding(
  workspace?: ConversationWorkspaceReadable,
  connectionStatus?: ChatLauncherConnectionStatus,
  activity?: ConversationActivityReadable,
): ConversationLauncherBinding {
  const combined = useConversationActivitySnapshot(workspace, activity);
  const runningCount = combined.filter((record) => record.turnStatus === "running").length;
  const errorCount = combined.filter((record) => record.turnStatus === "error").length;
  const unreadCount = combined.filter((record) => record.unread).length;
  const currentActivity = combined.filter((record) => record.turnStatus === "running" && record.summary)
    .sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))[0];
  return Object.freeze({
    ...(currentActivity?.progress === undefined ? {} : { activityProgress: currentActivity.progress }),
    ...(currentActivity?.summary === undefined ? {} : { activitySummary: currentActivity.summary }),
    ...(connectionStatus === undefined ? {} : { connectionStatus }),
    turnStatus: errorCount > 0 ? "error" as const :
      runningCount > 0 ? "busy" as const :
        unreadCount > 0 ? "completed" as const : "idle" as const,
    unreadCount,
  });
}
