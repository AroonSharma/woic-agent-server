/**
 * Enhanced Audio Sender with WebRTC VAD
 * Enterprise-grade audio capture with instant voice detection
 */

import { AudioPipeline, AudioChunk } from '../../ws/audio-pipeline';

export type MicSender = {
  stop: () => void;
  getStats: () => AudioStats;
};

export interface AudioStats {
  packetsSent: number;
  bytesSent: number;
  speechDetections: number;
  latency: number;
}

// Compose a binary frame compatible with server decodeBinaryFrame
function createBinaryFrame(header: object, payload: Uint8Array): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + headerJson.length + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.length, false); // big-endian
  const out = new Uint8Array(buffer);
  out.set(headerJson, 4);
  out.set(payload, 4 + headerJson.length);
  return buffer;
}

export function startSendingMic(params: {
  stream: MediaStream;
  ws: WebSocket;
  sessionId: string;
  turnId: string;
  sampleRate?: number;
  channels?: number;
  vadPreset?: 'sensitive' | 'normal' | 'robust';
}): MicSender {
  const { stream, ws, sessionId, turnId } = params;
  const targetRate = params.sampleRate ?? 16000;
  const channels = params.channels ?? 1;
  const vadPreset = params.vadPreset ?? 'sensitive';

  // Statistics
  const stats: AudioStats = {
    packetsSent: 0,
    bytesSent: 0,
    speechDetections: 0,
    latency: 0
  };

  // Create audio pipeline with WebRTC VAD
  const pipeline = new AudioPipeline({
    targetSampleRate: targetRate,
    channels,
    frameSize: 320,           // 20ms at 16kHz
    preBufferMs: 300,         // 300ms pre-buffer to catch speech start
    chunkDurationMs: 20,
    maxQueueSize: 100,
    noiseReduction: true,
    echoCancellation: true,
    autoGainControl: true
  });

  let seq = 0;
  let speechActive = false;
  
  // Set up pipeline callbacks
  pipeline.setCallbacks({
    onAudioChunk: (chunk: AudioChunk) => {
      // Only send if WebSocket is ready
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn('[AudioSender] WebSocket not ready, buffering audio');
        return;
      }
      
      // Create and send binary frame
      const header = {
        type: 'audio.chunk',
        ts: chunk.timestamp,
        sessionId,
        turnId,
        seq: seq++,
        codec: 'pcm16',
        sampleRate: targetRate,
        channels,
        isSpeech: chunk.isSpeech,
        energy: chunk.energy
      };
      
      const frame = createBinaryFrame(header, chunk.data);
      
      try {
        ws.send(frame);
        stats.packetsSent++;
        stats.bytesSent += frame.byteLength;
        
        // Log only speech frames for clarity
        if (chunk.isSpeech && !speechActive) {
          console.log('[AudioSender] Speech started, sending with pre-buffer');
          speechActive = true;
          stats.speechDetections++;
        } else if (!chunk.isSpeech && speechActive) {
          console.log('[AudioSender] Speech ended');
          speechActive = false;
        }
      } catch (e) {
        console.error('[AudioSender] Failed to send audio:', e);
      }
    },
    
    onSpeechStart: () => {
      console.log('[AudioSender] VAD: Speech detected!');
      // Could send a speech.start event to server
      try {
        ws.send(JSON.stringify({
          type: 'speech.start',
          ts: Date.now(),
          sessionId,
          turnId
        }));
      } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    },
    
    onSpeechEnd: () => {
      console.log('[AudioSender] VAD: Speech ended');
      // Could send a speech.end event to server
      try {
        ws.send(JSON.stringify({
          type: 'speech.end',
          ts: Date.now(),
          sessionId,
          turnId
        }));
      } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    }
  });

  // Initialize pipeline
  pipeline.initialize(stream).then(() => {
    console.log('[AudioSender] Audio pipeline initialized with VAD preset:', vadPreset);
  }).catch(err => {
    console.error('[AudioSender] Failed to initialize pipeline:', err);
  });

  // Monitor latency
  const latencyInterval = setInterval(() => {
    const pipelineStats = pipeline.getLatencyStats();
    stats.latency = pipelineStats.totalLatency;
    
    // Log if latency is high
    if (stats.latency > 50) {
      console.warn('[AudioSender] High audio latency:', stats.latency.toFixed(2), 'ms');
    }
  }, 1000);

  const stop = () => {
    clearInterval(latencyInterval);
    pipeline.stop();
    
    // Send audio.end event
    try {
      ws.send(JSON.stringify({
        type: 'audio.end',
        ts: Date.now(),
        sessionId,
        turnId
      }));
    } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    
    console.log('[AudioSender] Stopped. Stats:', stats);
  };

  const getStats = () => ({ ...stats });

  return { stop, getStats };
}

/**
 * Create a test audio sender for development
 */
export function createTestAudioSender(ws: WebSocket, sessionId: string, turnId: string): MicSender {
  console.log('[AudioSender] Creating test sender (no actual audio)');
  
  let interval: NodeJS.Timeout | null = null;
  let seq = 0;
  
  // Send periodic test frames
  interval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    // Create silent audio frame
    const silentPCM = new Uint8Array(640); // 20ms of silence at 16kHz
    const header = {
      type: 'audio.chunk',
      ts: Date.now(),
      sessionId,
      turnId,
      seq: seq++,
      codec: 'pcm16',
      sampleRate: 16000,
      channels: 1,
      isSpeech: false,
      energy: 0
    };
    
    const frame = createBinaryFrame(header, silentPCM);
    
    try {
      ws.send(frame);
    } catch (e: unknown) {
        console.error('[ws] Failed to send message:', e instanceof Error ? e.message : String(e));
      }
  }, 20); // Send every 20ms
  
  return {
    stop: () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
    getStats: () => ({
      packetsSent: seq,
      bytesSent: seq * 644,
      speechDetections: 0,
      latency: 0
    })
  };
}