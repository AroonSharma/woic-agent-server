import { DeepgramManager, type DeepgramConnectionOptions } from '../../deepgram-manager';
import type { STTCallbacks, STTProvider, STTAudioCodec } from './base';

export class DeepgramSTT implements STTProvider {
  name = 'Deepgram STT';
  type = 'deepgram' as const;
  private mgr: DeepgramManager;

  constructor() {
    this.mgr = new DeepgramManager();
  }

  connect(options: DeepgramConnectionOptions, callbacks: STTCallbacks, sessionContext?: any): void {
    this.mgr.createConnection(
      options,
      {
        onSttPartial: callbacks.onPartial,
        onSttFinal: callbacks.onFinal,
        onError: callbacks.onError,
        onReady: callbacks.onReady,
        onStateChange: callbacks.onStateChange,
      },
      sessionContext
    );
  }

  sendAudio(payload: Buffer, codec: STTAudioCodec = 'pcm16'): boolean {
    return this.mgr.sendAudio(payload, codec);
  }

  close(): void {
    this.mgr.closeConnection();
  }

  isReady(): boolean {
    return this.mgr.isReady();
  }

  async healthCheck(): Promise<boolean> {
    // Phase 2 note: could attempt a lightweight WS connect or REST ping.
    // For now, assume healthy if constructed; router will treat this as best-effort.
    return true;
  }
}
