// TTS provider base interface for Phase 1 (foundation)
// Standardizes streamed audio synthesis

export interface TTSStreamOptions {
  voiceId?: string;
  optimizeStreamingLatency?: number; // provider-specific (e.g., ElevenLabs 0-4)
  outputFormat?: string; // e.g., 'mp3_22050_32'
  signal?: AbortSignal;
}

export interface TTSProvider {
  name: string;
  type: 'elevenlabs' | 'openai' | 'google' | 'polly' | 'azure';

  // Stream synthesized audio as an async iterator of buffers
  stream(text: string, options?: TTSStreamOptions): AsyncIterable<Buffer>;

  healthCheck(): Promise<boolean>;
}

