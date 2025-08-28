import { WebSocket } from 'ws';
import * as dns from 'dns';
import { LOG_LEVEL } from './agent-config';

const isDebug = LOG_LEVEL === 'debug';
const dbg = (...args: unknown[]) => { if (isDebug) { try { console.log(...args); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      } } };

export type ElevenLabsStreamOptions = {
  apiKey: string;
  voiceId: string;
  text: string;
  optimizeStreamingLatency?: number; // 0-4
  outputFormat?: string; // e.g., 'mp3_22050_32'
  onChunk: (chunk: Buffer, seq: number) => void;
  onEnd: (reason: 'complete' | 'barge' | 'error') => void;
  signal?: AbortSignal;
};

export async function streamElevenLabsTTS(opts: ElevenLabsStreamOptions): Promise<void> {
  const {
    apiKey,
    voiceId,
    text,
    onChunk,
    onEnd,
    optimizeStreamingLatency = 2,
    outputFormat = 'mp3_22050_32',
    signal,
  } = opts;

  // API KEY & VOICE ID VALIDATION LOGGING
  console.log('[elevenlabs] 🔑 API Configuration:', {
    hasApiKey: !!apiKey,
    keyLength: apiKey ? apiKey.length : 0,
    keyPrefix: apiKey ? apiKey.substring(0, 8) + '...' : 'NO_KEY',
    hasVoiceId: !!voiceId,
    voiceIdLength: voiceId ? voiceId.length : 0,
    voiceIdPrefix: voiceId ? voiceId.substring(0, 8) + '...' : 'NO_VOICE_ID'
  });
  
  if (!apiKey || apiKey.length < 20) {
    console.error('[elevenlabs] ❌ INVALID API KEY - Key is missing or too short!');
    console.error('[elevenlabs] ❌ Expected: 20+ character string, Got:', apiKey?.length || 0, 'chars');
  }
  
  if (!voiceId || voiceId.length < 10) {
    console.error('[elevenlabs] ❌ INVALID VOICE ID - Voice ID is missing or too short!');
    console.error('[elevenlabs] ❌ Expected: 10+ character string, Got:', voiceId?.length || 0, 'chars');
  }

  const url = `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?optimize_streaming_latency=${optimizeStreamingLatency}&output_format=${outputFormat}`;
  console.log('[elevenlabs] 🌐 Connecting to:', url.replace(apiKey, 'API_KEY_HIDDEN'));

  let seq = 0;
  let closed = false;
  // Log DNS info for troubleshooting
  try {
    const { hostname } = new URL(url);
    dns.lookup(hostname, { all: true }, (err, addresses) => {
      if (err) { dbg('[elevenlabs] DNS lookup error for', hostname, err); }
      else { dbg('[elevenlabs] DNS lookup for', hostname, '→', addresses?.map((a: any) => `${a.address}/${a.family}`).join(', ')); }
    });
  } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }

  const ws = new WebSocket(url, {
    headers: {
      'xi-api-key': apiKey,
    },
    perMessageDeflate: false,
    handshakeTimeout: 7000,
  });

  // Reconnect with backoff on transient close/error before stream completes
  let reconnectAttempts = 0;
  const reconnect = async () => {
    if (closed) return;
    const base = 300; // ms
    const delay = Math.min(5000, base * Math.pow(2, reconnectAttempts)) + Math.floor(Math.random() * 200);
    reconnectAttempts = Math.min(reconnectAttempts + 1, 6);
    dbg('[elevenlabs] Reconnecting in', delay, 'ms');
    await new Promise((r) => setTimeout(r, delay));
    if (closed) return;
    try {
      await streamElevenLabsTTS(opts);
    } catch {
      // will bubble via onEnd('error') in nested call
    }
  };

  const abortHandler = () => {
    if (closed) return;
    closed = true;
    try { ws.close(); } catch {} // Cleanup operation - empty catch is intentional
    onEnd('barge');
  };
  signal?.addEventListener('abort', abortHandler, { once: true });

  await new Promise<void>((resolve, reject) => {
    // @ts-ignore
    ws.once('upgrade', (res: any) => { try { dbg('[elevenlabs] Upgrade status:', res?.statusCode, 'headers:', res?.headers); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      } });
    ws.once('open', () => resolve());
    ws.once('error', (e) => {
      console.error('[elevenlabs] 🚨 WebSocket error during connect:', e);
      
      // ENHANCED API KEY ERROR DETECTION
      const errorMsg = e?.message || String(e);
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('invalid api key')) {
        console.error('[elevenlabs] 🚨🔑 API KEY ERROR DETECTED!');
        console.error('[elevenlabs] 🚨🔑 This error is likely due to an invalid or expired ElevenLabs API key');
        console.error('[elevenlabs] 🚨🔑 Current key starts with:', apiKey?.substring(0, 8) + '...' || 'NO_KEY');
      }
      
      if (errorMsg.includes('voice') || errorMsg.includes('not found')) {
        console.error('[elevenlabs] 🚨🎵 VOICE ID ERROR DETECTED!');
        console.error('[elevenlabs] 🚨🎵 Voice ID may be invalid or not accessible with this API key');
        console.error('[elevenlabs] 🚨🎵 Current voice ID:', voiceId || 'NO_VOICE_ID');
      }
      
      reject(e);
    });
  });

  // protocol: send a small priming message, then the text, then end_of_stream
  const sendJson = (obj: any) => ws.send(JSON.stringify(obj));

  sendJson({
    text: ' ',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    prefill: true,
  });

  sendJson({ text });
  sendJson({ try_trigger_generation: true });
  sendJson({ end_of_stream: true });

  ws.on('message', (data) => {
    // ElevenLabs sends JSON wrapped in a Buffer, need to convert and parse
    let messageStr: string;
    
    if (Buffer.isBuffer(data)) {
      // Convert buffer to string (it contains JSON)
      messageStr = data.toString('utf8');
    } else {
      messageStr = String(data);
    }
    
    try {
      const message = JSON.parse(messageStr);
      
      if (message.audio) {
        const audioBuffer = Buffer.from(message.audio, 'base64');
        dbg('[elevenlabs] Decoded audio chunk:', audioBuffer.length, 'bytes');
        onChunk(audioBuffer, seq++);
        return;
      }

      // Handle terminal states and errors explicitly
      if (message.isFinal) {
        console.log('[elevenlabs] Stream complete');
        return;
      }

      if (message?.error || message?.code || /quota/i.test(String(message?.message || ''))) {
        console.log('[elevenlabs] Error from ElevenLabs stream, ending:', message);
        if (!closed) {
          closed = true;
          try { ws.close(); } catch {} // Cleanup operation - empty catch is intentional
          onEnd('error');
        }
        return;
      }

      dbg('[elevenlabs] Other message:', message);
    } catch (e) {
      console.error('[elevenlabs] Failed to parse message:', e);
      dbg('[elevenlabs] Raw data preview:', messageStr.slice(0, 100));
    }
  });

  ws.on('close', () => {
    if (closed) return;
    closed = true;
    // Attempt reconnect if we haven't delivered any audio yet (transient network blip)
    if (seq === 0) {
      reconnect();
      return;
    }
    onEnd('complete');
  });

  ws.on('error', (e) => {
    if (closed) return;
    console.error('[elevenlabs] 🚨 WebSocket stream error:', e);
    
    // ENHANCED API KEY ERROR DETECTION
    const errorMsg = e?.message || String(e);
    if (errorMsg.includes('401') || errorMsg.includes('Unauthorized') || errorMsg.includes('invalid api key')) {
      console.error('[elevenlabs] 🚨🔑 STREAM API KEY ERROR - Invalid or expired ElevenLabs API key!');
    }
    
    closed = true;
    reconnect();
  });
}
