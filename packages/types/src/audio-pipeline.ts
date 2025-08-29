/**
 * Audio Pipeline Manager
 * Enterprise-grade audio processing pipeline with ultra-low latency
 * Implements techniques used by leading voice AI companies
 */

import { WebRTCVAD, createVAD } from './webrtc-vad';

export interface AudioPipelineConfig {
  // Audio processing
  targetSampleRate: number;
  channels: number;
  frameSize: number;           // Samples per frame
  
  // Buffering strategy
  preBufferMs: number;         // Pre-speech buffer duration
  chunkDurationMs: number;     // Duration of each chunk sent
  maxQueueSize: number;        // Max chunks in queue
  
  // Performance
  useWorker: boolean;          // Process in Web Worker
  enableCompression: boolean;  // Compress audio chunks
  
  // Quality
  noiseReduction: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
}

export interface AudioChunk {
  data: Uint8Array;
  timestamp: number;
  isSpeech: boolean;
  energy: number;
  sequence: number;
}

export class AudioPipeline {
  private config: AudioPipelineConfig;
  private vad: WebRTCVAD;
  private audioContext: AudioContext | null = null;
  private processor: AudioWorkletNode | ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Buffering
  private preBuffer: Float32Array[] = [];
  private sendQueue: AudioChunk[] = [];
  private isProcessing: boolean = false;
  private sequence: number = 0;
  
  // State
  private isSpeaking: boolean = false;
  private lastSpeechTime: number = 0;
  private silenceChunks: number = 0;
  
  // Callbacks
  private onAudioChunk?: (chunk: AudioChunk) => void;
  private onSpeechStart?: () => void;
  private onSpeechEnd?: () => void;
  
  // Performance monitoring
  private latencyStats = {
    captureLatency: 0,
    processingLatency: 0,
    vadLatency: 0,
    totalLatency: 0
  };

  constructor(config?: Partial<AudioPipelineConfig>) {
    this.config = {
      targetSampleRate: 16000,
      channels: 1,
      frameSize: 320,             // 20ms at 16kHz
      preBufferMs: 300,           // 300ms pre-buffer
      chunkDurationMs: 20,        // 20ms chunks
      maxQueueSize: 100,
      useWorker: false,           // TODO: Implement worker
      enableCompression: false,
      noiseReduction: true,
      echoCancellation: true,
      autoGainControl: true,
      ...config
    };
    
    // Create VAD with sensitive settings for instant detection
    this.vad = createVAD('sensitive');
  }

  /**
   * Initialize pipeline with media stream
   */
  async initialize(stream: MediaStream): Promise<void> {
    const startTime = performance.now();
    
    // Create audio context with low latency hint
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000  // Use native rate, downsample later
    });
    
    // Apply audio constraints for better quality
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      await audioTrack.applyConstraints({
        echoCancellation: this.config.echoCancellation,
        noiseSuppression: this.config.noiseReduction,
        autoGainControl: this.config.autoGainControl,
        sampleRate: 48000,
        channelCount: 1
      });
    }
    
    // Initialize VAD
    await this.vad.initialize(stream);
    this.vad.setCallbacks({
      onSpeechStart: (buffer) => this.handleSpeechStart(buffer),
      onSpeechEnd: () => this.handleSpeechEnd()
    });
    
    // Create audio source
    this.source = this.audioContext.createMediaStreamSource(stream);
    
    // Try to use AudioWorklet for better performance
    if (this.audioContext.audioWorklet && false) { // Disabled for now
      // TODO: Implement AudioWorklet processor
    } else {
      // Fallback to ScriptProcessor
      this.setupScriptProcessor();
    }
    
    const initTime = performance.now() - startTime;
    console.log('[AudioPipeline] Initialized in', initTime.toFixed(2), 'ms');
  }

  /**
   * Setup ScriptProcessor for audio processing
   */
  private setupScriptProcessor(): void {
    if (!this.audioContext || !this.source) return;
    
    // Use smaller buffer for lower latency
    const bufferSize = 512; // ~10ms at 48kHz
    this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
    
    this.processor.onaudioprocess = (event) => {
      const captureTime = performance.now();
      const inputData = event.inputBuffer.getChannelData(0);
      
      // Process with VAD
      const vadStart = performance.now();
      const vadResult = this.vad.processFrame(inputData);
      this.latencyStats.vadLatency = performance.now() - vadStart;
      
      // Handle based on VAD result
      if (vadResult.isSpeaking || this.isSpeaking) {
        this.processAudioFrame(inputData, vadResult.isSpeaking);
      } else {
        // Keep small buffer even during silence for instant response
        this.updatePreBuffer(inputData);
      }
      
      this.latencyStats.captureLatency = performance.now() - captureTime;
    };
    
    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  /**
   * Process audio frame for sending
   */
  private processAudioFrame(data: Float32Array, isSpeech: boolean): void {
    const processStart = performance.now();
    
    // Downsample to target rate
    const downsampled = this.downsample(data, this.audioContext!.sampleRate, this.config.targetSampleRate);
    
    // Convert to PCM16
    const pcm16 = this.floatTo16BitPCM(downsampled);
    
    // Create chunk
    const chunk: AudioChunk = {
      data: new Uint8Array(pcm16.buffer),
      timestamp: Date.now(),
      isSpeech,
      energy: this.calculateEnergy(data),
      sequence: this.sequence++
    };
    
    // Send immediately if speaking, queue otherwise
    if (isSpeech) {
      this.sendChunk(chunk);
      this.silenceChunks = 0;
    } else {
      // Send a few silence chunks after speech for natural trailing
      if (this.silenceChunks < 5) {
        this.sendChunk(chunk);
        this.silenceChunks++;
      }
    }
    
    this.latencyStats.processingLatency = performance.now() - processStart;
  }

  /**
   * Update pre-speech buffer
   */
  private updatePreBuffer(data: Float32Array): void {
    const maxFrames = Math.ceil(
      (this.config.preBufferMs / 1000) * this.audioContext!.sampleRate / data.length
    );
    
    this.preBuffer.push(new Float32Array(data));
    if (this.preBuffer.length > maxFrames) {
      this.preBuffer.shift();
    }
  }

  /**
   * Handle speech start event from VAD
   */
  private handleSpeechStart(buffer: Float32Array[]): void {
    console.log('[AudioPipeline] Speech started, sending pre-buffer:', buffer.length, 'frames');
    this.isSpeaking = true;
    this.lastSpeechTime = Date.now();
    
    // Process and send pre-buffered audio
    for (const frame of buffer) {
      this.processAudioFrame(frame, true);
    }
    
    // Clear pre-buffer
    this.preBuffer = [];
    
    this.onSpeechStart?.();
  }

  /**
   * Handle speech end event from VAD
   */
  private handleSpeechEnd(): void {
    console.log('[AudioPipeline] Speech ended');
    this.isSpeaking = false;
    this.onSpeechEnd?.();
  }

  /**
   * Send audio chunk
   */
  private sendChunk(chunk: AudioChunk): void {
    // Apply compression if enabled
    if (this.config.enableCompression) {
      // TODO: Implement compression (e.g., Opus)
    }
    
    // Check queue size
    if (this.sendQueue.length >= this.config.maxQueueSize) {
      console.warn('[AudioPipeline] Queue full, dropping oldest chunk');
      this.sendQueue.shift();
    }
    
    // Add to queue or send directly
    if (this.onAudioChunk) {
      this.onAudioChunk(chunk);
    } else {
      this.sendQueue.push(chunk);
    }
  }

  /**
   * Downsample audio data
   */
  private downsample(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
    if (inputRate === outputRate) return input;
    
    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    
    // Use linear interpolation for quality
    for (let i = 0; i < outputLength; i++) {
      const inputIndex = i * ratio;
      const inputIndexFloor = Math.floor(inputIndex);
      const inputIndexCeil = Math.min(inputIndexFloor + 1, input.length - 1);
      const fraction = inputIndex - inputIndexFloor;
      
      output[i] = input[inputIndexFloor] * (1 - fraction) + input[inputIndexCeil] * fraction;
    }
    
    return output;
  }

  /**
   * Convert float samples to 16-bit PCM
   */
  private floatTo16BitPCM(input: Float32Array): Int16Array {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output;
  }

  /**
   * Calculate audio energy
   */
  private calculateEnergy(data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: {
    onAudioChunk?: (chunk: AudioChunk) => void;
    onSpeechStart?: () => void;
    onSpeechEnd?: () => void;
  }): void {
    this.onAudioChunk = callbacks.onAudioChunk;
    this.onSpeechStart = callbacks.onSpeechStart;
    this.onSpeechEnd = callbacks.onSpeechEnd;
  }

  /**
   * Get latency statistics
   */
  getLatencyStats(): typeof this.latencyStats {
    this.latencyStats.totalLatency = 
      this.latencyStats.captureLatency + 
      this.latencyStats.processingLatency + 
      this.latencyStats.vadLatency;
    return { ...this.latencyStats };
  }

  /**
   * Flush send queue
   */
  flushQueue(): AudioChunk[] {
    const chunks = [...this.sendQueue];
    this.sendQueue = [];
    return chunks;
  }

  /**
   * Stop pipeline
   */
  stop(): void {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.vad.destroy();
  }
}