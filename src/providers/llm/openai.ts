import OpenAI from 'openai';
import type { ChatMessage } from '../../types';
import type { LLMOptions, LLMProvider } from './base';

// Simple price sheet placeholder for Phase 1 (tokens are approximate)
const PRICE_SHEET = {
  openai: {
    gpt4omini: { perToken: 0.00000015 }, // example: $0.15 / 1M tokens
  },
};

export interface OpenAILLMConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
}

export class OpenAILLM implements LLMProvider {
  name = 'OpenAI GPT-4o-mini';
  type = 'openai' as const;
  private client: OpenAI;
  private defaultModel: string;
  private defaultTemperature: number;

  constructor(cfg: OpenAILLMConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey });
    this.defaultModel = cfg.model || 'gpt-4o-mini';
    this.defaultTemperature = cfg.temperature ?? 0.2;
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens;
    console.log('[llm][openai] chat start model=', model, 'msgs=', messages.length, 'temp=', temperature, 'maxTokens=', maxTokens ?? 'na');

    const res = await this.client.chat.completions.create(
      {
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
        temperature,
        max_tokens: maxTokens,
        stream: false,
      },
      options?.signal ? { signal: options.signal } : undefined
    );

    const content = res.choices?.[0]?.message?.content ?? '';
    console.log('[llm][openai] chat done chars=', content.length);
    return content;
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens;
    console.log('[llm][openai] stream start model=', model, 'msgs=', messages.length, 'temp=', temperature, 'maxTokens=', maxTokens ?? 'na');

    const stream = await this.client.chat.completions.create(
      {
        model,
        messages: messages.map((m) => ({ role: m.role, content: m.content } as OpenAI.Chat.Completions.ChatCompletionMessageParam)),
        temperature,
        max_tokens: maxTokens,
        stream: true,
      },
      options?.signal ? { signal: options.signal } : undefined
    );

    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        // Log only the first few characters to avoid noise
        if ((stream as any).__loggedFirst !== true) {
          console.log('[llm][openai] stream first delta.len=', delta.length, 'sample=', String(delta).slice(0, 40));
          (stream as any).__loggedFirst = true;
        }
        yield delta;
      }
    }
  }

  estimateCost(tokens: number): number {
    // Basic estimate using placeholder price sheet
    return tokens * PRICE_SHEET.openai.gpt4omini.perToken;
  }

  getMaxTokens(): number {
    return 128_000; // context window hint
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Minimal call to check auth/availability (model list or lightweight completion)
      await this.client.models.list();
      return true;
    } catch {
      return false;
    }
  }
}
