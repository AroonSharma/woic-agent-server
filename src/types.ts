/**
 * Type definitions for the WOIC WebSocket agent server
 * Standalone implementation without external dependencies
 */

import { z } from 'zod';

// ===== MESSAGE TYPES =====

export interface SessionStart {
  type: 'session.start';
  sessionId: string;
  turnId: string;
  agentId?: string;
  userId?: string;
  timestamp: number;
  data: {
    agentId?: string;
    userId?: string;
    jwt?: string;
    knowledgeBase?: any;
    systemPrompt?: string;
    voiceId?: string;
    endpointing?: EndpointingConfig;
  };
}

export interface STTPartial {
  type: 'stt.partial';
  text: string;
  timestamp: number;
}

export interface STTFinal {
  type: 'stt.final';
  text: string;
  timestamp: number;
}

export interface TestUtterance {
  type: 'test.utterance';
  text: string;
  timestamp: number;
  sessionId: string;
  turnId: string;
  data: {
    text: string;
  };
}

export interface LLMPartial {
  type: 'llm.partial';
  text: string;
  timestamp: number;
}

export interface LLMFinal {
  type: 'llm.final';
  text: string;
  timestamp: number;
}

export interface TTSEnd {
  type: 'tts.end';
  reason: 'complete' | 'barge' | 'error';
  timestamp: number;
}

export interface AudioEnd {
  type: 'audio.end';
  timestamp: number;
}

export interface BargeCancel {
  type: 'barge.cancel';
  timestamp: number;
}

export interface MetricsUpdate {
  type: 'metrics.update';
  metrics: {
    activeCalls: number;
    totalTurns: number;
    lastLatencyMs: number;
  };
  timestamp: number;
}

export interface ErrorEvent {
  type: 'error';
  message: string;
  code?: string;
  timestamp: number;
}

export interface AudioChunkHeader {
  type: 'audio.chunk';
  sequence: number;
  seq: number;
  timestamp: number;
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface TTSChunkHeader {
  type: 'tts.chunk';
  sequence: number;
  timestamp: number;
}

export interface SessionEnd {
  type: 'session.end';
  sessionId: string;
  timestamp: number;
}

// ===== ZOD SCHEMAS =====

export const SessionStartSchema = z.object({
  type: z.literal('session.start'),
  sessionId: z.string(),
  turnId: z.string(),
  agentId: z.string().optional(),
  userId: z.string().optional(),
  timestamp: z.number(),
  data: z.object({
    agentId: z.string().optional(),
    userId: z.string().optional(),
    jwt: z.string().optional(),
    knowledgeBase: z.any().optional(),
    systemPrompt: z.string().optional(),
    voiceId: z.string().optional(),
    endpointing: z.any().optional()
  })
});

export const STTPartialSchema = z.object({
  type: z.literal('stt.partial'),
  text: z.string(),
  timestamp: z.number()
});

export const STTFinalSchema = z.object({
  type: z.literal('stt.final'),
  text: z.string(),
  timestamp: z.number()
});

export const TestUtteranceSchema = z.object({
  type: z.literal('test.utterance'),
  text: z.string(),
  timestamp: z.number()
});

export const LLMPartialSchema = z.object({
  type: z.literal('llm.partial'),
  text: z.string(),
  timestamp: z.number()
});

export const LLMFinalSchema = z.object({
  type: z.literal('llm.final'),
  text: z.string(),
  timestamp: z.number()
});

export const TTSEndSchema = z.object({
  type: z.literal('tts.end'),
  reason: z.enum(['complete', 'barge', 'error']),
  timestamp: z.number()
});

export const AudioEndSchema = z.object({
  type: z.literal('audio.end'),
  timestamp: z.number()
});

export const BargeCancelSchema = z.object({
  type: z.literal('barge.cancel'),
  timestamp: z.number()
});

export const MetricsUpdateSchema = z.object({
  type: z.literal('metrics.update'),
  metrics: z.object({
    activeCalls: z.number(),
    totalTurns: z.number(),
    lastLatencyMs: z.number()
  }),
  timestamp: z.number()
});

export const ErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
  code: z.string().optional(),
  timestamp: z.number()
});

export const AudioChunkHeaderSchema = z.object({
  type: z.literal('audio.chunk'),
  sequence: z.number(),
  timestamp: z.number()
});

export const TTSChunkHeaderSchema = z.object({
  type: z.literal('tts.chunk'),
  sequence: z.number(),
  timestamp: z.number()
});

export const EnvelopeSchema = z.discriminatedUnion('type', [
  SessionStartSchema,
  STTPartialSchema,
  STTFinalSchema,
  TestUtteranceSchema,
  LLMPartialSchema,
  LLMFinalSchema,
  TTSEndSchema,
  AudioEndSchema,
  BargeCancelSchema,
  MetricsUpdateSchema,
  ErrorSchema,
  AudioChunkHeaderSchema,
  TTSChunkHeaderSchema
]);

// ===== UTILITY FUNCTIONS =====

export function encodeBinaryFrame(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(typeBytes.length, 0);
  return Buffer.concat([header, typeBytes, data]);
}

export function decodeBinaryFrame(frame: Buffer): { type: string; data: Buffer } | null {
  if (frame.length < 4) return null;
  const typeLength = frame.readUInt32LE(0);
  
  // Validate type length is reasonable (prevent malformed frames)
  if (typeLength > 1000 || typeLength < 1) {
    console.error('[decodeBinaryFrame] Invalid type length:', typeLength);
    return null;
  }
  
  if (frame.length < 4 + typeLength) {
    console.error('[decodeBinaryFrame] Frame too short for declared type length:', frame.length, 'vs expected:', 4 + typeLength);
    return null;
  }
  
  const type = frame.subarray(4, 4 + typeLength).toString('utf8');
  
  // Check if type looks like JSON (malformed client)
  if (type.startsWith('{') || type.startsWith('[')) {
    console.error('[decodeBinaryFrame] Type field contains JSON, expected simple string:', type.substring(0, 50) + '...');
    return null;
  }
  
  const data = frame.subarray(4 + typeLength);
  return { type, data };
}

export function nowTs(): number {
  return Date.now();
}

// ===== BASIC ENVELOPE TYPE =====

export interface Envelope {
  type: string;
  [key: string]: any;
}

// ===== OPENAI MESSAGE TYPES =====

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ===== KNOWLEDGE BASE TYPES =====

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

// ===== ENDPOINTING CONFIG =====

export type EndpointingConfig = {
  waitSeconds: number;
  punctuationSeconds: number;
  noPunctSeconds: number;
  numberSeconds: number;
  smartEndpointing: boolean;
};

// ===== AGENT CONFIGURATION =====

export interface AgentData {
  id: string;
  name: string;
  systemPrompt?: string;
  voiceId?: string;
  endpointing?: EndpointingConfig;
}

// ===== DEEPGRAM TYPES =====

export interface DeepgramTranscript {
  text: string;
  isFinal: boolean;
  speechFinal: boolean;
}

// ===== ELEVENLABS TYPES =====

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

// ===== TYPE GUARDS =====

export function isSessionStartMessage(msg: Envelope): msg is SessionStart {
  return msg.type === 'session.start';
}

export function isSTTFinalMessage(msg: Envelope): msg is STTFinal {
  return msg.type === 'stt.final';
}

export function isTestUtteranceMessage(msg: Envelope): msg is TestUtterance {
  return msg.type === 'test.utterance';
}

export function isAudioChunkMessage(msg: Envelope): msg is AudioChunkHeader {
  return msg.type === 'audio.chunk';
}

export function isLLMPartialMessage(msg: Envelope): msg is LLMPartial {
  return msg.type === 'llm.partial';
}

export function isLLMFinalMessage(msg: Envelope): msg is LLMFinal {
  return msg.type === 'llm.final';
}

export function isTTSEndMessage(msg: Envelope): msg is TTSEnd {
  return msg.type === 'tts.end';
}

export function isErrorMessage(msg: Envelope): msg is ErrorEvent {
  return msg.type === 'error';
}