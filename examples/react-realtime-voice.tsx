import type { BrowserRealtimeVoiceController } from "@handrail/ai/browser";
import {
  RealtimeVoiceCancel,
  RealtimeVoiceCapabilities,
  RealtimeVoiceControlsRoot,
  RealtimeVoiceControlsStatus,
  RealtimeVoiceEndSession,
  RealtimeVoiceInterrupt,
  RealtimeVoiceMute,
  RealtimeVoiceStart,
  RealtimeVoiceStopMicrophone,
  RealtimeVoiceUnmute,
  useRealtimeVoiceControls,
} from "@handrail/ai/react";

/**
 * Credential-free recipe. The host constructs the provider-neutral browser
 * controller and injects trusted bootstrap/exchange/hangup callbacks there.
 * React neither receives credentials nor executes server tools.
 */
export function RealtimeVoiceRecipe({
  controller,
}: {
  readonly controller: BrowserRealtimeVoiceController;
}) {
  const voice = useRealtimeVoiceControls({ controller });

  return (
    <RealtimeVoiceControlsRoot controller={voice} aria-label="Voice controls">
      <RealtimeVoiceControlsStatus />
      <RealtimeVoiceCapabilities />
      <RealtimeVoiceStart />
      <RealtimeVoiceMute />
      <RealtimeVoiceUnmute />
      <RealtimeVoiceStopMicrophone />
      <RealtimeVoiceInterrupt />
      <RealtimeVoiceEndSession />
      <RealtimeVoiceCancel />
    </RealtimeVoiceControlsRoot>
  );
}
