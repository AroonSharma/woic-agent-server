import { z } from 'zod';

// Base envelope schema (for JSON messages)
export const EnvelopeSchema = z.object({
  type: z.string(),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  data: z.unknown().optional(),
});
export type Envelope<T = unknown> = z.infer<typeof EnvelopeSchema> & { data?: T };

// Client -> Server events (JSON)
export const SessionStartSchema = EnvelopeSchema.extend({
  type: z.literal('session.start'),
  data: z.object({
    systemPrompt: z.string().default(''),
    voiceId: z.string().nullable().optional(),
    vadEnabled: z.boolean().default(true),
    pttMode: z.boolean().default(false),
    agentId: z.string().optional(),
    token: z.string().optional(),
    endpointing: z
      .object({
        waitSeconds: z.number().nonnegative().default(0.4),
        punctuationSeconds: z.number().nonnegative().default(0.1),
        noPunctSeconds: z.number().nonnegative().default(1.5),
        numberSeconds: z.number().nonnegative().default(0.5),
        smartEndpointing: z.boolean().default(false),
      })
      .default({
        waitSeconds: 0.4,
        punctuationSeconds: 0.1,
        noPunctSeconds: 1.5,
        numberSeconds: 0.5,
        smartEndpointing: false,
      }),
  }),
});
export type SessionStart = z.infer<typeof SessionStartSchema>;

export const AudioEndSchema = EnvelopeSchema.extend({
  type: z.literal('audio.end'),
});
export type AudioEnd = z.infer<typeof AudioEndSchema>;

export const BargeCancelSchema = EnvelopeSchema.extend({
  type: z.literal('barge.cancel'),
});
export type BargeCancel = z.infer<typeof BargeCancelSchema>;

export const TestUtteranceSchema = EnvelopeSchema.extend({
  type: z.literal('test.utterance'),
  data: z.object({ text: z.string().min(1) }),
});
export type TestUtterance = z.infer<typeof TestUtteranceSchema>;

// Server -> Client events (JSON)
export const STTPartialSchema = EnvelopeSchema.extend({
  type: z.literal('stt.partial'),
  data: z.object({ text: z.string() }),
});
export type STTPartial = z.infer<typeof STTPartialSchema>;

export const STTFinalSchema = EnvelopeSchema.extend({
  type: z.literal('stt.final'),
  data: z.object({ text: z.string(), startTs: z.number().int(), endTs: z.number().int() }),
});
export type STTFinal = z.infer<typeof STTFinalSchema>;

export const LLMPartialSchema = EnvelopeSchema.extend({
  type: z.literal('llm.partial'),
  data: z.object({ text: z.string() }),
});
export type LLMPartial = z.infer<typeof LLMPartialSchema>;

export const LLMFinalSchema = EnvelopeSchema.extend({
  type: z.literal('llm.final'),
  data: z.object({ text: z.string() }),
});
export type LLMFinal = z.infer<typeof LLMFinalSchema>;

export const TTSEndSchema = EnvelopeSchema.extend({
  type: z.literal('tts.end'),
  data: z.object({ reason: z.enum(['complete', 'barge', 'error']).default('complete') }),
});
export type TTSEnd = z.infer<typeof TTSEndSchema>;

export const MetricsUpdateSchema = EnvelopeSchema.extend({
  type: z.literal('metrics.update'),
  data: z.object({
    sttMs: z.number().int().optional(),
    llmFirstTokenMs: z.number().int().optional(),
    ttsFirstAudioMs: z.number().int().optional(),
    e2eMs: z.number().int().optional(),
    alive: z.boolean().optional(),
  }),
});
export type MetricsUpdate = z.infer<typeof MetricsUpdateSchema>;

export const ErrorSchema = EnvelopeSchema.extend({
  type: z.literal('error'),
  data: z.object({
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean().default(true),
    details: z.unknown().optional(),
  }),
});
export type ErrorEvent = z.infer<typeof ErrorSchema>;

// Binary frame header (first 4 bytes = header length big-endian, then JSON header, then raw bytes)
export const AudioChunkHeaderSchema = z.object({
  type: z.literal('audio.chunk'),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  codec: z.enum(['pcm16', 'opus']),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive().default(1),
});
export type AudioChunkHeader = z.infer<typeof AudioChunkHeaderSchema>;

export const TTSChunkHeaderSchema = z.object({
  type: z.literal('tts.chunk'),
  ts: z.number().int(),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  mime: z.union([
    z.literal('audio/mpeg'),
    z.literal('audio/mp3'),
    z.literal('audio/mp4'),
    z.literal('audio/webm'),
    z.literal('audio/ogg'),
    z.literal('audio/wav'),
  ]),
});
export type TTSChunkHeader = z.infer<typeof TTSChunkHeaderSchema>;

export function encodeBinaryFrame(header: object, payload: Buffer | Uint8Array): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(headerJson.length, 0);
  const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([lenBuf, headerJson, payloadBuf]);
}

export function decodeBinaryFrame(frame: Buffer): { header: any; payload: Buffer } {
  if (frame.length < 4) throw new Error('frame too short');
  const headerLen = frame.readUInt32BE(0);
  if (frame.length < 4 + headerLen) throw new Error('invalid header length');
  const headerJson = frame.subarray(4, 4 + headerLen).toString('utf8');
  const header = JSON.parse(headerJson);
  const payload = frame.subarray(4 + headerLen);
  return { header, payload };
}

export function nowTs(): number {
  return Date.now();
}
