import type { ChatMessage } from '../../types';
import type { LLMOptions, LLMProvider } from './base';

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
}

/**
 * Anthropic Claude LLM adapter
 * - Supports streaming and non-streaming chat completions
 * - Compatible with Claude 3.5 Sonnet, Claude 3 Haiku, etc.
 * - Uses Anthropic's Messages API format
 */
export class AnthropicLLM implements LLMProvider {
  name = 'Anthropic Claude';
  type = 'anthropic' as const;

  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;
  private defaultTemperature: number;

  constructor(cfg: AnthropicConfig) {
    this.apiKey = cfg.apiKey;
    this.baseURL = cfg.baseURL || 'https://api.anthropic.com';
    this.defaultModel = cfg.model || 'claude-3-5-sonnet-20241022';
    this.defaultTemperature = cfg.temperature ?? 0.7;
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens || 1024;

    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessages(messages);

    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: anthropicMessages.messages,
        system: anthropicMessages.system,
      }),
      signal: options?.signal as any,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${error}`);
    }

    const data = await response.json() as any;
    return data.content?.[0]?.text || '';
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens || 1024;

    // Convert messages to Anthropic format
    const anthropicMessages = this.convertMessages(messages);

    const response = await fetch(`${this.baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        messages: anthropicMessages.messages,
        system: anthropicMessages.system,
        stream: true,
      }),
      signal: options?.signal as any,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API streaming error: ${response.status} ${error}`);
    }

    if (!response.body) {
      throw new Error('No response body for streaming');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.replace('data: ', '');
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              yield parsed.delta.text;
            }
          } catch (e) {
            // Skip invalid JSON chunks
            continue;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private convertMessages(messages: ChatMessage[]): {
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    system?: string;
  } {
    let systemMessage = '';
    const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content;
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        anthropicMessages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }

    return {
      messages: anthropicMessages,
      system: systemMessage || undefined,
    };
  }

  estimateCost(tokens: number): number {
    // Claude 3.5 Sonnet pricing (approximate)
    // Input: $3 per 1M tokens, Output: $15 per 1M tokens
    // Using average of $9 per 1M tokens for estimation
    const perToken = 0.000009;
    return tokens * perToken;
  }

  getMaxTokens(): number {
    // Claude 3.5 Sonnet supports 200K context window
    return 200_000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Simple health check with minimal request
      const response = await fetch(`${this.baseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.defaultModel,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      return response.status < 500; // Accept 4xx but not 5xx errors
    } catch {
      return false;
    }
  }
}