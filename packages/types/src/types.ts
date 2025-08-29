/**
 * Type definitions for the WebSocket agent server
 * Uses proper Zod schemas from @vapi/types package for validation
 */

// Re-export all the validated types from the shared package
export type {
  SessionStart,
  SessionStart as SessionStartMessage,
  STTFinal, 
  STTFinal as STTFinalMessage,
  TestUtterance,
  TestUtterance as TestUtteranceMessage, 
  AudioChunkHeader,
  AudioChunkHeader as AudioChunkMessage,
  TTSChunkHeader,
  ErrorEvent as ErrorMessage,
  LLMPartial,
  LLMFinal,
  TTSEnd,
  MetricsUpdate
} from '@vapi/types';

// Re-export schemas for runtime validation
export {
  SessionStartSchema,
  STTFinalSchema, 
  TestUtteranceSchema,
  AudioChunkHeaderSchema,
  ErrorSchema
} from '@vapi/types';

// Basic envelope type for message wrapping
export interface Envelope {
  type: string;
  [key: string]: any;
}

// OpenAI message types
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// Knowledge Base types
export interface KBChunk {
  id: string;
  content: string;
  score: number;
  sourceId: string;
}

export interface GroundedAnswerResult {
  text: string;
  sources: Array<{
    sourceId: string;
    title: string;
    url: string | null;
  }>;
}

// Extract EndpointingConfig from the Zod schema 
export type EndpointingConfig = {
  waitSeconds: number;
  punctuationSeconds: number;
  noPunctSeconds: number;
  numberSeconds: number;
  smartEndpointing: boolean;
};

// Agent configuration from database
export interface AgentData {
  id: string;
  name: string;
  systemPrompt?: string;
  voiceId?: string;
  endpointing?: EndpointingConfig;
}

// Deepgram types
export interface DeepgramTranscript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

// ElevenLabs types
export interface ElevenLabsStreamOptions {
  apiKey: string;
  voiceId: string;
  text: string;
  optimizeStreamingLatency?: number;
  outputFormat?: string;
  onChunk: (chunk: Buffer, seq: number) => void;
  onEnd: (reason: 'complete' | 'barge' | 'error') => void;
  signal?: AbortSignal;
}

// Type guards
export function isSessionStartMessage(msg: Envelope): boolean {
  return msg.type === 'session.start';
}

export function isSTTFinalMessage(msg: Envelope): boolean {
  return msg.type === 'stt.final';
}

export function isTestUtteranceMessage(msg: Envelope): boolean {
  return msg.type === 'test.utterance';
}

export function isAudioChunkMessage(msg: Envelope): boolean {
  return msg.type === 'audio.chunk';
}