// @ts-nocheck
export type MicSender = { stop: () => void };

function createBinaryFrame(header: object, payload: Uint8Array): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const buffer = new ArrayBuffer(4 + headerJson.length + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.length, false);
  const out = new Uint8Array(buffer);
  out.set(headerJson, 4);
  out.set(payload, 4 + headerJson.length);
  return buffer;
}

function floatTo16BitPCM(input: Float32Array, gain: number = 1.0): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let s = Math.max(-1, Math.min(1, input[i] * gain));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function downsampleTo16000(input: Float32Array, inputSampleRate: number): Float32Array {
  if (inputSampleRate === 16000) return input;
  const sampleRateRatio = inputSampleRate / 16000;
  const outLength = Math.floor(input.length / sampleRateRatio);
  const result = new Float32Array(outLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    result[offsetResult] = accum / (count || 1);
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

export function startSendingMic(params: {
  stream: MediaStream;
  ws: WebSocket;
  sessionId: string;
  turnId: string;
  sampleRate?: number;
  channels?: number;
  onLevel?: (rms: number) => void;
}): MicSender {
  const { stream, ws, sessionId, turnId, onLevel } = params;
  const targetRate = params.sampleRate ?? 16000;
  const channels = params.channels ?? 1;

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);

  let seq = 0;
  const frameBuffer: Float32Array[] = [];

  function handleAudioBlock(inputData: Float32Array) {
    if (onLevel) {
      // Compute simple RMS for visualization
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      try { onLevel(rms); } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
    }
    const down = downsampleTo16000(inputData, ctx.sampleRate);
    frameBuffer.push(down);

    const samplesPer20ms = (targetRate / 50) | 0; // 20ms
    const totalLen = frameBuffer.reduce((a, b) => a + b.length, 0);
    if (totalLen >= samplesPer20ms) {
      const merged = new Float32Array(totalLen);
      let off = 0;
      for (const part of frameBuffer) { merged.set(part, off); off += part.length; }
      frameBuffer.length = 0;
      for (let i = 0; i + samplesPer20ms <= merged.length; i += samplesPer20ms) {
        const slice = merged.subarray(i, i + samplesPer20ms);
        const pcm16 = floatTo16BitPCM(slice);
        const payload = new Uint8Array(pcm16.buffer);
        const header = {
          type: 'audio.chunk', ts: Date.now(), sessionId, turnId, seq: seq++,
          codec: 'pcm16', sampleRate: targetRate, channels,
        };
        const frame = createBinaryFrame(header, payload);
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(frame); } catch (e: unknown) {
        console.error('[ws] Failed to send message:', e instanceof Error ? e.message : String(e));
      }
        }
      }
    }
  }

  // Prefer AudioWorklet; fallback to ScriptProcessorNode
  let spNode: ScriptProcessorNode | null = null;
  const attachScriptProcessor = () => {
    const PROCESSOR_BUFFER_SIZE = 1024;
    spNode = ctx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, channels, channels);
    spNode.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      handleAudioBlock(inputData);
    };
    source.connect(spNode);
    // Do not connect to destination to avoid feedback
  };

  try {
    if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
      // Load worklet asynchronously without making this function async
      (ctx.audioWorklet.addModule('/audio/mic-worklet.js') as Promise<void>)
        .then(() => {
          const worklet = new (window as any).AudioWorkletNode(ctx, 'mic-worklet', { processorOptions: { channels } });
          worklet.port.onmessage = (ev: MessageEvent) => {
            if (ev.data?.type === 'block' && ev.data?.buffer) {
              if (ev.data.buffer instanceof ArrayBuffer) {
                const view = new Float32Array(ev.data.buffer);
                handleAudioBlock(view);
              } else {
                // Direct Float32Array
                handleAudioBlock(ev.data.buffer as Float32Array);
              }
            }
          };
          source.connect(worklet as any);
          // Do not route mic to destination to avoid feedback
        })
        .catch(() => {
          attachScriptProcessor();
        });
    } else {
      attachScriptProcessor();
    }
  } catch {
    attachScriptProcessor();
  }

  const stop = () => {
    console.log('[mic] Stopping microphone capture...');
    
    // 1. Disconnect audio processing nodes
    try { 
      if (spNode) {
        spNode.disconnect();
        spNode = null;
        console.log('[mic] Disconnected ScriptProcessorNode');
      }
    } catch (e: unknown) {
      console.error('[mic] Error disconnecting ScriptProcessorNode:', e instanceof Error ? e.message : String(e));
    }
    
    try { 
      source.disconnect();
      console.log('[mic] Disconnected MediaStreamSource');
    } catch (e: unknown) {
      console.error('[mic] Error disconnecting MediaStreamSource:', e instanceof Error ? e.message : String(e));
    }
    
    // 2. Stop all MediaStream tracks (THIS WAS MISSING!)
    try {
      const tracks = stream.getTracks();
      tracks.forEach(track => {
        track.stop();
        console.log(`[mic] Stopped ${track.kind} track:`, track.label);
      });
      console.log(`[mic] Stopped ${tracks.length} MediaStream tracks`);
    } catch (e: unknown) {
      console.error('[mic] Error stopping MediaStream tracks:', e instanceof Error ? e.message : String(e));
    }
    
    // 3. Close audio context
    try { 
      ctx.close();
      console.log('[mic] Closed AudioContext');
    } catch (e: unknown) {
      console.error('[mic] Error closing AudioContext:', e instanceof Error ? e.message : String(e));
    }
    
    // 4. Send audio.end message to server
    try { 
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio.end', ts: Date.now(), sessionId, turnId }));
        console.log('[mic] Sent audio.end message to server');
      }
    } catch (e: unknown) {
      console.error('[mic] Failed to send audio.end message:', e instanceof Error ? e.message : String(e));
    }
    
    console.log('[mic] Microphone stop complete');
  };

  return { stop };
}