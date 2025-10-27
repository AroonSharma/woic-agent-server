"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TTSChunkHeaderSchema = exports.AudioChunkHeaderSchema = exports.ErrorSchema = exports.MetricsUpdateSchema = exports.TTSEndSchema = exports.LLMFinalSchema = exports.LLMPartialSchema = exports.STTFinalSchema = exports.STTPartialSchema = exports.TestUtteranceSchema = exports.BargeCancelSchema = exports.AudioEndSchema = exports.SessionStartSchema = exports.EnvelopeSchema = void 0;
exports.encodeBinaryFrame = encodeBinaryFrame;
exports.decodeBinaryFrame = decodeBinaryFrame;
exports.nowTs = nowTs;
const zod_1 = require("zod");
// Base envelope schema (for JSON messages)
exports.EnvelopeSchema = zod_1.z.object({
    type: zod_1.z.string(),
    ts: zod_1.z.number().int(),
    sessionId: zod_1.z.string().min(1),
    turnId: zod_1.z.string().min(1),
    data: zod_1.z.unknown().optional(),
});
// Client -> Server events (JSON)
exports.SessionStartSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('session.start'),
    data: zod_1.z.object({
        systemPrompt: zod_1.z.string().default(''),
        voiceId: zod_1.z.string().nullable().optional(),
        vadEnabled: zod_1.z.boolean().default(true),
        pttMode: zod_1.z.boolean().default(false),
        agentId: zod_1.z.string().optional(),
        token: zod_1.z.string().optional(),
        endpointing: zod_1.z
            .object({
            waitSeconds: zod_1.z.number().nonnegative().default(0.4),
            punctuationSeconds: zod_1.z.number().nonnegative().default(0.1),
            noPunctSeconds: zod_1.z.number().nonnegative().default(1.5),
            numberSeconds: zod_1.z.number().nonnegative().default(0.5),
            smartEndpointing: zod_1.z.boolean().default(false),
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
exports.AudioEndSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('audio.end'),
});
exports.BargeCancelSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('barge.cancel'),
});
exports.TestUtteranceSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('test.utterance'),
    data: zod_1.z.object({ text: zod_1.z.string().min(1) }),
});
// Server -> Client events (JSON)
exports.STTPartialSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('stt.partial'),
    data: zod_1.z.object({ text: zod_1.z.string() }),
});
exports.STTFinalSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('stt.final'),
    data: zod_1.z.object({ text: zod_1.z.string(), startTs: zod_1.z.number().int(), endTs: zod_1.z.number().int() }),
});
exports.LLMPartialSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('llm.partial'),
    data: zod_1.z.object({ text: zod_1.z.string() }),
});
exports.LLMFinalSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('llm.final'),
    data: zod_1.z.object({ text: zod_1.z.string() }),
});
exports.TTSEndSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('tts.end'),
    data: zod_1.z.object({ reason: zod_1.z.enum(['complete', 'barge', 'error']).default('complete') }),
});
exports.MetricsUpdateSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('metrics.update'),
    data: zod_1.z.object({
        sttMs: zod_1.z.number().int().optional(),
        llmFirstTokenMs: zod_1.z.number().int().optional(),
        ttsFirstAudioMs: zod_1.z.number().int().optional(),
        e2eMs: zod_1.z.number().int().optional(),
        alive: zod_1.z.boolean().optional(),
    }),
});
exports.ErrorSchema = exports.EnvelopeSchema.extend({
    type: zod_1.z.literal('error'),
    data: zod_1.z.object({
        code: zod_1.z.string(),
        message: zod_1.z.string(),
        recoverable: zod_1.z.boolean().default(true),
        details: zod_1.z.unknown().optional(),
    }),
});
// Binary frame header (first 4 bytes = header length big-endian, then JSON header, then raw bytes)
exports.AudioChunkHeaderSchema = zod_1.z.object({
    type: zod_1.z.literal('audio.chunk'),
    ts: zod_1.z.number().int(),
    sessionId: zod_1.z.string().min(1),
    turnId: zod_1.z.string().min(1),
    seq: zod_1.z.number().int().nonnegative(),
    codec: zod_1.z.enum(['pcm16', 'opus']),
    sampleRate: zod_1.z.number().int().positive(),
    channels: zod_1.z.number().int().positive().default(1),
});
exports.TTSChunkHeaderSchema = zod_1.z.object({
    type: zod_1.z.literal('tts.chunk'),
    ts: zod_1.z.number().int(),
    sessionId: zod_1.z.string().min(1),
    turnId: zod_1.z.string().min(1),
    seq: zod_1.z.number().int().nonnegative(),
    mime: zod_1.z.union([
        zod_1.z.literal('audio/mpeg'),
        zod_1.z.literal('audio/mp3'),
        zod_1.z.literal('audio/mp4'),
        zod_1.z.literal('audio/webm'),
        zod_1.z.literal('audio/ogg'),
        zod_1.z.literal('audio/wav'),
    ]),
});
function encodeBinaryFrame(header, payload) {
    const headerJson = Buffer.from(JSON.stringify(header), 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(headerJson.length, 0);
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    return Buffer.concat([lenBuf, headerJson, payloadBuf]);
}
function decodeBinaryFrame(frame) {
    if (frame.length < 4)
        throw new Error('frame too short');
    const headerLen = frame.readUInt32BE(0);
    if (frame.length < 4 + headerLen)
        throw new Error('invalid header length');
    const headerJson = frame.subarray(4, 4 + headerLen).toString('utf8');
    const header = JSON.parse(headerJson);
    const payload = frame.subarray(4 + headerLen);
    return { header, payload };
}
function nowTs() {
    return Date.now();
}
