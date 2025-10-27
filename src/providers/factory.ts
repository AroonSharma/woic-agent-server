// ProviderFactory for Phase 1 (foundation)
// Constructs providers for multi-provider architecture

import { agentConfig, getElevenLabsConfig } from '../agent-config';
import type { LLMProvider } from './llm/base';
import { OpenAILLM } from './llm/openai';
import { AnthropicLLM } from './llm/anthropic';
import { GeminiLLM } from './llm/gemini';
import type { STTProvider } from './stt/base';
import { DeepgramSTT } from './stt/deepgram';
import type { TTSProvider } from './tts/base';
import { ElevenLabsTTS } from './tts/elevenlabs';
import { OpenAITTS } from './tts/openai';

export type LLMType = 'gemini' | 'anthropic' | 'openai';
export type STTType = 'deepgram';
export type TTSType = 'elevenlabs' | 'openai';

export class ProviderFactory {
  // LLM
  static createLLM(type: LLMType = 'openai', opts?: { model?: string; temperature?: number }): LLMProvider {
    switch (type) {
      case 'gemini': {
        const apiKey = process.env.GEMINI_API_KEY || '';
        const baseURL = process.env.GEMINI_BASE_URL;
        const model = opts?.model || process.env.GEMINI_MODEL || 'gemini-1.5-pro-latest';
        const temperature = opts?.temperature ?? (process.env.GEMINI_TEMPERATURE ? Number(process.env.GEMINI_TEMPERATURE) : undefined);
        if (!apiKey) {
          throw new Error('GEMINI_API_KEY environment variable is required for Gemini LLM');
        }
        return new GeminiLLM({ apiKey, baseURL, model, temperature });
      }
      case 'anthropic': {
        const apiKey = process.env.ANTHROPIC_API_KEY || '';
        const baseURL = process.env.ANTHROPIC_BASE_URL;
        const model = opts?.model || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022';
        const temperature = opts?.temperature ?? (process.env.ANTHROPIC_TEMPERATURE ? Number(process.env.ANTHROPIC_TEMPERATURE) : undefined);
        if (!apiKey) {
          throw new Error('ANTHROPIC_API_KEY environment variable is required for Anthropic LLM');
        }
        return new AnthropicLLM({ apiKey, baseURL, model, temperature });
      }
      case 'openai':
        return new OpenAILLM({
          apiKey: agentConfig.apiKeys.openaiApiKey,
          model: opts?.model,
          temperature: opts?.temperature,
        });
      default:
        throw new Error(`Unsupported LLM type: ${type}`);
    }
  }

  // STT - Deepgram only
  static createSTT(type: STTType = 'deepgram'): STTProvider {
    switch (type) {
      case 'deepgram':
        return new DeepgramSTT();
      default:
        throw new Error(`Unsupported STT type: ${type}`);
    }
  }

  // TTS
  static createTTS(type: TTSType = 'elevenlabs', opts?: { voiceId?: string }): TTSProvider {
    switch (type) {
      case 'openai':
        return new OpenAITTS();
      case 'elevenlabs':
      default: {
        const { apiKey, voiceId } = getElevenLabsConfig(opts?.voiceId);
        return new ElevenLabsTTS({ apiKey, voiceId });
      }
    }
  }
}
