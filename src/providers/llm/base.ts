// LLM provider base interface for Phase 1 (foundation)
// Unifies chat and streaming across vendors

import type { ChatMessage } from '../../types';

export interface LLMOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  // Abort support for callers that want to cancel requests
  signal?: AbortSignal;
}

export interface LLMProvider {
  name: string;
  type: 'openai' | 'anthropic' | 'google' | 'deepseek' | 'custom';

  chat(messages: ChatMessage[], options?: LLMOptions): Promise<string>;

  stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string>;

  estimateCost(tokens: number): number;

  getMaxTokens(): number;

  healthCheck(): Promise<boolean>;
}

