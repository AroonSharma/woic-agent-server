import { streamElevenLabsTTS } from '../../elevenlabs';
import type { TTSProvider, TTSStreamOptions } from './base';

// Wrap ElevenLabs callback API into an async iterator of Buffers
export class ElevenLabsTTS implements TTSProvider {
  name = 'ElevenLabs TTS';
  type = 'elevenlabs' as const;
  private apiKey: string;
  private defaultVoiceId: string;

  constructor(cfg: { apiKey: string; voiceId: string }) {
    this.apiKey = cfg.apiKey;
    this.defaultVoiceId = cfg.voiceId;
  }

  async *stream(text: string, options?: TTSStreamOptions): AsyncIterable<Buffer> {
    const voiceId = options?.voiceId || this.defaultVoiceId;
    const optimizeStreamingLatency = options?.optimizeStreamingLatency ?? 2;
    const outputFormat = options?.outputFormat || 'mp3_22050_32';

    // Simple async queue to bridge callback-style streaming to async iterator
    const queue: Buffer[] = [];
    let resolveNext: ((value: IteratorResult<Buffer>) => void) | null = null;
    let done = false;

    const push = (buf: Buffer) => {
      if (resolveNext) {
        const r = resolveNext({ value: buf, done: false });
        resolveNext = null;
        return r;
      }
      queue.push(buf);
    };

    const end = () => {
      done = true;
      if (resolveNext) {
        resolveNext({ value: undefined as any, done: true });
        resolveNext = null;
      }
    };

    // Fire and forget the streaming call; it will fill the queue
    void streamElevenLabsTTS({
      apiKey: this.apiKey,
      voiceId,
      text,
      optimizeStreamingLatency,
      outputFormat,
      signal: options?.signal,
      onChunk: (chunk) => push(chunk),
      onEnd: () => end(),
    }).catch(() => end());

    // Async iterator protocol
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift()!;
        yield next;
        continue;
      }
      if (done) break;
      const nextVal = await new Promise<IteratorResult<Buffer>>((resolve) => {
        resolveNext = resolve;
      });
      if (nextVal.done) break;
      yield nextVal.value as Buffer;
    }
  }

  async healthCheck(): Promise<boolean> {
    // ElevenLabs has no cheap health endpoint via WS; assume true in Phase 1
    return true;
  }
}

