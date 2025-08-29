import { encodeBinaryFrame, decodeBinaryFrame, TTSChunkHeaderSchema, AudioChunkHeaderSchema } from '@vapi/types';

export const name = 'encodeDecode';

export async function run(assert: (cond: any, msg: string) => void) {
  const header = { type: 'tts.chunk', ts: Date.now(), sessionId: 's', turnId: 't', seq: 1, mime: 'audio/mpeg' };
  const payload = Buffer.from([1,2,3,4]);
  const frame = encodeBinaryFrame(header, payload);
  const { header: dec, payload: decPayload } = decodeBinaryFrame(frame);
  const parsed = TTSChunkHeaderSchema.safeParse(dec);
  assert(parsed.success, 'decoded header should validate');
  assert(decPayload.equals(payload), 'payload roundtrip');

  const aHeader = { type: 'audio.chunk', ts: Date.now(), sessionId: 's', turnId: 't', seq: 0, codec: 'pcm16', sampleRate: 16000, channels: 1 };
  const aFrame = encodeBinaryFrame(aHeader, Buffer.from([5,6,7]));
  const { header: aDec } = decodeBinaryFrame(aFrame);
  const aParsed = AudioChunkHeaderSchema.safeParse(aDec);
  assert(aParsed.success, 'audio header should validate');
}
