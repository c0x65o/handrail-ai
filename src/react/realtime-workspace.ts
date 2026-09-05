import { useSyncExternalStore } from "react";
import { EMPTY_REALTIME_WORKSPACE, type RealtimeWorkspaceMonitor } from "../realtime/workspace.js";
const empty = () => EMPTY_REALTIME_WORKSPACE;
const none = () => () => {};
/** Headless observation: hosts own presentation; reads never acknowledge voice. */
export function useRealtimeWorkspaceActivity(monitor?: RealtimeWorkspaceMonitor | null) {
  return useSyncExternalStore(monitor?.subscribe ?? none, monitor?.getSnapshot ?? empty, empty);
}
