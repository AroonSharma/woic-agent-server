import type { ChatMessage } from '../../types';
import type { LLMOptions, LLMProvider } from './base';

export interface GeminiConfig {
  apiKey: string;
  baseURL?: string;
  model?: string;
  temperature?: number;
}

/**
 * Google Gemini LLM adapter
 * - Supports streaming and non-streaming chat completions
 * - Compatible with Gemini Pro, Gemini Pro Vision, etc.
 * - Uses Google's Generative AI API format
 */
export class GeminiLLM implements LLMProvider {
  name = 'Google Gemini';
  type = 'google' as const;

  private apiKey: string;
  private baseURL: string;
  private defaultModel: string;
  private defaultTemperature: number;

  constructor(cfg: GeminiConfig) {
    this.apiKey = cfg.apiKey;
    this.baseURL = cfg.baseURL || 'https://generativelanguage.googleapis.com';
    this.defaultModel = cfg.model || 'gemini-1.5-pro-latest';
    this.defaultTemperature = cfg.temperature ?? 0.7;
  }

  async chat(messages: ChatMessage[], options?: LLMOptions): Promise<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens || 2048;

    // Convert messages to Gemini format
    const geminiMessages = this.convertMessages(messages);

    const url = `${this.baseURL}/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: geminiMessages.contents,
        systemInstruction: geminiMessages.systemInstruction,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          candidateCount: 1,
        },
      }),
      signal: options?.signal as any,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${error}`);
    }

    const data = await response.json() as any;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return content;
  }

  async *stream(messages: ChatMessage[], options?: LLMOptions): AsyncIterable<string> {
    const model = options?.model || this.defaultModel;
    const temperature = options?.temperature ?? this.defaultTemperature;
    const maxTokens = options?.maxTokens || 2048;

    // Convert messages to Gemini format
    const geminiMessages = this.convertMessages(messages);

    const url = `${this.baseURL}/v1beta/models/${model}:streamGenerateContent?key=${this.apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: geminiMessages.contents,
        systemInstruction: geminiMessages.systemInstruction,
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
          candidateCount: 1,
        },
      }),
      signal: options?.signal as any,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API streaming error: ${response.status} ${error}`);
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
        const lines = chunk.split('\n').filter(line => line.trim() && line.startsWith('data: '));

        for (const line of lines) {
          const data = line.replace('data: ', '');
          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              yield text;
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
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    systemInstruction?: { parts: Array<{ text: string }> };
  } {
    let systemInstruction: { parts: Array<{ text: string }> } | undefined;
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = {
          parts: [{ text: msg.content }]
        };
      } else {
        // Map roles for Gemini
        const role = msg.role === 'assistant' ? 'model' : msg.role;
        contents.push({
          role,
          parts: [{ text: msg.content }]
        });
      }
    }

    return {
      contents,
      systemInstruction,
    };
  }

  estimateCost(tokens: number): number {
    // Gemini Pro pricing (approximate)
    // Input: $0.50 per 1M tokens, Output: $1.50 per 1M tokens
    // Using average of $1.00 per 1M tokens for estimation
    const perToken = 0.000001;
    return tokens * perToken;
  }

  getMaxTokens(): number {
    // Gemini 1.5 Pro supports up to 2M context window
    return 2_000_000;
  }

  async healthCheck(): Promise<boolean> {
    try {
      // Simple health check with minimal request
      const url = `${this.baseURL}/v1beta/models/${this.defaultModel}:generateContent?key=${this.apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{ text: 'Hi' }]
          }],
          generationConfig: {
            maxOutputTokens: 1,
          },
        }),
      });
      return response.status < 500; // Accept 4xx but not 5xx errors
    } catch {
      return false;
    }
  }
}