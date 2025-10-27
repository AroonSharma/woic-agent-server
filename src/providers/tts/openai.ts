import type { TTSProvider, TTSStreamOptions } from './base';
import { agentConfig } from '../../agent-config';

/**
 * OpenAI TTS adapter (Phase 1):
 * - Uses gpt-4o-mini-tts (or compatible) via audio.speech API.
 * - Emits a single audio Buffer as the stream for simplicity.
 */
export class OpenAITTS implements TTSProvider {
  name = 'OpenAI TTS';
  type = 'openai' as const;

  async *stream(text: string, options?: TTSStreamOptions): AsyncIterable<Buffer> {
    const model = 'tts-1';
    const voice = options?.voiceId || 'alloy';
    const format = (options?.outputFormat || 'mp3') as any;
    console.log('[tts][openai] stream start model=', model, 'voice=', voice, 'text.len=', text?.length || 0, 'format=', format);

    // Create full audio and yield once (Phase 1 simplicity)
    const res = await agentConfig.openai.audio.speech.create({
      model,
      voice,
      input: text,
      format,
    } as any);

    const arrayBuf = await res.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    console.log('[tts][openai] stream yield bytes=', buf.length);
    yield buf;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await agentConfig.openai.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
