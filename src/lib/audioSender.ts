export type MicSender = {
  stop: () => void;
};

// Compose a binary frame compatible with server decodeBinaryFrame
function createBinaryFrame(header: object, payload: Uint8Array): ArrayBuffer {
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  // Removed excessive logging per AMP analysis - hot path optimization
  const buffer = new ArrayBuffer(4 + headerJson.length + payload.byteLength);
  const view = new DataView(buffer);
  view.setUint32(0, headerJson.length, false); // false = big-endian to match server expectation
  // Copy header JSON and payload bytes
  const out = new Uint8Array(buffer);
  out.set(headerJson, 4);
  out.set(payload, 4 + headerJson.length);
  return buffer;
}

function floatTo16BitPCM(input: Float32Array, gain: number = 1.0): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    // Apply gain to boost audio level
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
  sampleRate?: number; // target sample rate, default 16000
  channels?: number; // default 1
}): MicSender {
  const { stream, ws, sessionId, turnId } = params;
  const targetRate = params.sampleRate ?? 16000;
  const channels = params.channels ?? 1;

  const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const PROCESSOR_BUFFER_SIZE = 1024;
  let processor: ScriptProcessorNode | AudioWorkletNode | null = null;

  let seq = 0;
  const frameBuffer: Float32Array[] = [];
  
  // Enhanced Voice activity detection parameters (with hysteresis)
  const START_THRESHOLD = 0.0025;    // Start talking when above this level
  const STOP_THRESHOLD = 0.0012;     // Stop talking only when below this level
  const MIN_SPEECH_DURATION_MS = 120; // Capture short single-word utterances
  const SILENCE_DURATION_MS = 900;    // Allow short pauses without cutting
  const PRE_SPEECH_BUFFER_MS = 200; // Buffer speech before detection
  
  let isCurrentlySpeaking = false;
  let speechStartTime = 0;
  let lastSpeechTime = 0;
  let silenceFrameCount = 0;
  
  // Pre-speech buffering for instant response
  const preBuffer: Float32Array[] = [];
  const maxPreBufferFrames = Math.ceil((PRE_SPEECH_BUFFER_MS / 1000) * (ctx.sampleRate / PROCESSOR_BUFFER_SIZE));

  function calculateRMS(data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  const handleAudioBlock = (inputData: Float32Array) => {
    const audioLevel = calculateRMS(inputData);
    const now = Date.now();
    
    // Optimized debug logging per AMP analysis - reduce frequency
    if (now % 1000 < 50) {
      console.log('[audioSender] Audio level:', audioLevel.toFixed(4), 'startThr:', START_THRESHOLD, 'stopThr:', STOP_THRESHOLD, 'speaking:', isCurrentlySpeaking);
    }
    
    // Determine speaking state with hysteresis
    const speakingNow = isCurrentlySpeaking
      ? audioLevel > STOP_THRESHOLD
      : audioLevel > START_THRESHOLD;

    if (speakingNow) {
      if (!isCurrentlySpeaking) {
        speechStartTime = now;
        console.log('[audioSender] Speech detected, starting capture');
      }
      isCurrentlySpeaking = true;
      lastSpeechTime = now;
      silenceFrameCount = 0;
    } else {
      silenceFrameCount++;
      // Stop sending if we've been silent long enough
      if (isCurrentlySpeaking && (now - lastSpeechTime) > SILENCE_DURATION_MS) {
        console.log('[audioSender] Silence detected, stopping capture');
        isCurrentlySpeaking = false;
      }
    }
    
    // Always buffer recent audio for pre-speech capture
    const down = downsampleTo16000(inputData, ctx.sampleRate);
    preBuffer.push(down);
    if (preBuffer.length > maxPreBufferFrames) {
      preBuffer.shift();
    }
    
    // Process and send audio if speaking or just started speaking
    if (isCurrentlySpeaking && (now - speechStartTime) > MIN_SPEECH_DURATION_MS) {
      // If just started speaking, include pre-buffered audio
      if (frameBuffer.length === 0 && preBuffer.length > 0) {
        console.log('[audioSender] Including', preBuffer.length, 'pre-buffered frames');
        frameBuffer.push(...preBuffer.slice());
        preBuffer.length = 0; // Clear pre-buffer
      }
      frameBuffer.push(down);
      
      // Concatenate to a reasonable chunk size (~20-40ms)
      const samplesPer20ms = (targetRate / 50) | 0; // 20ms
      const totalLen = frameBuffer.reduce((a, b) => a + b.length, 0);
      if (totalLen >= samplesPer20ms) {
        const merged = new Float32Array(totalLen);
        let off = 0;
        for (const part of frameBuffer) {
          merged.set(part, off);
          off += part.length;
        }
        frameBuffer.length = 0;
        
        // Slice into frames of samplesPer20ms
        for (let i = 0; i + samplesPer20ms <= merged.length; i += samplesPer20ms) {
          const slice = merged.subarray(i, i + samplesPer20ms);
          const pcm16 = floatTo16BitPCM(slice);
          const payload = new Uint8Array(pcm16.buffer);
          const header = {
            type: 'audio.chunk',
            ts: Date.now(),
            sessionId,
            turnId,
            seq: seq++,
            codec: 'pcm16',
            sampleRate: targetRate,
            channels,
          };
          const frame = createBinaryFrame(header, payload);
          // Reduced logging frequency for performance per AMP analysis
          if (seq % 25 === 0) console.log('[audioSender] Sending frame seq:', seq, 'bytes:', frame.byteLength);
          try { ws.send(frame); } catch { /* ignore */ }
        }
      }
    } else if (speakingNow && isCurrentlySpeaking) {
      // Continue capturing during initial speech period
      frameBuffer.push(down);
    }
    // Note: Pre-buffer continues during silence above
  };

  const attachScriptProcessor = () => {
    const node = ctx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, channels, channels);
    node.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      handleAudioBlock(inputData);
    };
    processor = node;
    source.connect(node);
    // Do not route mic to destination to avoid feedback
  };

  const init = async () => {
    try {
      if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === 'function') {
        // Use AudioWorklet by default; falls back to ScriptProcessor
        await ctx.audioWorklet.addModule('/audio/mic-worklet.js');
        const worklet = new (window as any).AudioWorkletNode(ctx, 'mic-worklet', { processorOptions: { channels } });
        worklet.port.onmessage = (ev: MessageEvent) => {
          if (ev.data?.type === 'block' && ev.data?.buffer instanceof ArrayBuffer === false) {
            handleAudioBlock(ev.data.buffer as Float32Array);
          } else if (ev.data?.type === 'block' && ev.data?.buffer) {
            // Safari may transfer ArrayBuffer; reconstruct Float32Array
            const view = new Float32Array(ev.data.buffer);
            handleAudioBlock(view);
          }
        };
        source.connect(worklet as any);
        // Do not route mic to destination to avoid feedback
        processor = worklet as any;
        if (process.env.NODE_ENV !== 'production') console.log('[audioSender] Using AudioWorkletNode for mic capture');
      } else {
        if (process.env.NODE_ENV !== 'production') console.log('[audioSender] AudioWorklet not available; using ScriptProcessorNode');
        attachScriptProcessor();
      }
    } catch (e) {
      if (process.env.NODE_ENV !== 'production') console.log('[audioSender] Worklet init failed; falling back to ScriptProcessor', e);
      attachScriptProcessor();
    }
  };
  init();
  // Connection is performed inside init()

  const stop = () => {
    try { processor?.disconnect(); } catch {} // Cleanup operation - empty catch is intentional
    try { source.disconnect(); } catch {} // Cleanup operation - empty catch is intentional
    try { ctx.close(); } catch {} // Cleanup operation - empty catch is intentional
    try {
      ws.send(
        JSON.stringify({
          type: 'audio.end',
          ts: Date.now(),
          sessionId,
          turnId,
        }),
      );
    } catch (e: unknown) {
        console.error('[error] Unexpected error:', e instanceof Error ? e.message : String(e));
      }
  };

  return { stop };
}
