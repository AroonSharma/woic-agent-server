// STT provider base interface for Phase 1 (foundation)
// Wraps realtime streaming STT providers behind a common API

export type STTEncoding = 'linear16' | 'opus';
export type STTAudioCodec = 'pcm16' | 'opus';

export interface STTConnectionOptions {
  encoding: STTEncoding;
  sampleRate: number;
  channels: number;
}

export interface STTCallbacks {
  onPartial: (transcript: string) => void;
  onFinal: (transcript: string) => void;
  onError: (error: unknown) => void;
  onReady?: (info: { connectLatencyMs: number; queueSize: number }) => void;
  onStateChange?: (state: 'connecting' | 'open' | 'closing' | 'closed' | 'reconnecting') => void;
}

export interface STTProvider {
  name: string;
  type: 'deepgram' | 'assemblyai' | 'google';

  connect(options: STTConnectionOptions, callbacks: STTCallbacks, sessionContext?: any): void | Promise<void>;

  sendAudio(payload: Buffer, codec?: STTAudioCodec): boolean;

  close(): void;

  isReady(): boolean;

  healthCheck?(): Promise<boolean>;
}
