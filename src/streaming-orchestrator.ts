/**
 * Streaming Orchestrator
 * Handles parallel streaming of STT → LLM → TTS pipeline
 * Implements techniques from Vapi, Retell, and other enterprise voice platforms
 */

import { DeepgramManager } from './deepgram-manager';
import { streamElevenLabsTTS } from './elevenlabs';
import { conversationMemory } from './conversation-memory';
import { IntentAnalyzer } from './intent-analyzer';
import OpenAI from 'openai';

export interface StreamingConfig {
  // Pipeline control
  enableParallelStreaming: boolean;    // Stream LLM while STT is still processing
  enableSpeculativeExecution: boolean; // Start common responses early
  enableFirstTokenOptimization: boolean; // Optimize for first token latency
  
  // Timing thresholds (ms)
  interimConfidenceThreshold: number;  // Confidence to start LLM on interim
  maxWaitForFinal: number;             // Max wait for STT final
  llmStreamingDelay: number;           // Delay before starting LLM
  ttsStreamingDelay: number;           // Delay before starting TTS
  
  // Interruption control
  bargeInThreshold: number;            // Words needed to interrupt
  turnTakingEnabled: boolean;          // Smart turn-taking
}

export interface PipelineMetrics {
  sttLatency: number;
  llmFirstTokenLatency: number;
  llmCompleteLatency: number;
  ttsFirstChunkLatency: number;
  totalLatency: number;
  interrupted: boolean;
}

interface TurnState {
  id: string;
  startTime: number;
  sttStarted: boolean;
  sttCompleted: boolean;
  llmStarted: boolean;
  llmCompleted: boolean;
  ttsStarted: boolean;
  ttsCompleted: boolean;
  interrupted: boolean;
  metrics: PipelineMetrics;
}

export class StreamingOrchestrator {
  private config: StreamingConfig;
  private deepgramManager: DeepgramManager;
  private intentAnalyzer: IntentAnalyzer;
  private openaiClient: OpenAI;
  
  // Current turn state
  private currentTurn: TurnState | null = null;
  private turnHistory: TurnState[] = [];
  
  // Streaming state
  private currentTranscript: string = '';
  private interimTranscript: string = '';
  private llmBuffer: string = '';
  private llmAbortController: AbortController | null = null;
  private ttsAbortController: AbortController | null = null;
  
  // Callbacks
  private callbacks: {
    onSttPartial?: (text: string) => void;
    onSttFinal?: (text: string) => void;
    onLlmPartial?: (text: string) => void;
    onLlmFinal?: (text: string) => void;
    onTtsChunk?: (chunk: Buffer) => void;
    onTtsEnd?: (reason: string) => void;
    onMetrics?: (metrics: PipelineMetrics) => void;
  } = {};

  constructor(
    openaiClient: OpenAI,
    config?: Partial<StreamingConfig>
  ) {
    this.config = {
      enableParallelStreaming: true,
      enableSpeculativeExecution: true,
      enableFirstTokenOptimization: true,
      interimConfidenceThreshold: 0.85,
      maxWaitForFinal: 1000,
      llmStreamingDelay: 50,     // Reduced from 200ms per AMP analysis
      ttsStreamingDelay: 20,     // Reduced from 100ms per AMP analysis
      bargeInThreshold: 2,       // Reduced threshold for faster interruption
      turnTakingEnabled: true,
      ...config
    };
    
    this.openaiClient = openaiClient;
    this.deepgramManager = new DeepgramManager();
    this.intentAnalyzer = new IntentAnalyzer();
  }

  /**
   * Start a new conversation turn
   */
  startTurn(sessionId: string): void {
    // Interrupt current turn if active
    if (this.currentTurn && !this.currentTurn.ttsCompleted) {
      this.interruptTurn();
    }
    
    // Create new turn
    this.currentTurn = {
      id: `turn_${Date.now()}`,
      startTime: performance.now(),
      sttStarted: false,
      sttCompleted: false,
      llmStarted: false,
      llmCompleted: false,
      ttsStarted: false,
      ttsCompleted: false,
      interrupted: false,
      metrics: {
        sttLatency: 0,
        llmFirstTokenLatency: 0,
        llmCompleteLatency: 0,
        ttsFirstChunkLatency: 0,
        totalLatency: 0,
        interrupted: false
      }
    };
    
    console.log('[Orchestrator] Started new turn:', this.currentTurn.id);
  }

  /**
   * Initialize Deepgram connection with optimized settings
   */
  initializeSTT(
    sessionId: string,
    encoding: 'linear16' | 'opus' = 'linear16',
    sampleRate: number = 16000
  ): void {
    const callbacks = {
      onSttPartial: (transcript: string) => this.handleSttPartial(transcript),
      onSttFinal: (transcript: string) => this.handleSttFinal(transcript, sessionId),
      onError: (error: any) => console.error('[Orchestrator] STT error:', error)
    };
    
    // Use optimized Deepgram settings for low latency
    this.deepgramManager.createConnection(
      { encoding, sampleRate, channels: 1 },
      callbacks,
      { 
        // Override with faster settings
        endpointing: {
          waitSeconds: 0.3,      // 300ms instead of 800ms
          punctuationSeconds: 0.05,
          noPunctSeconds: 0.5,   // 500ms instead of 1.5s
          numberSeconds: 0.2,
          smartEndpointing: true
        }
      }
    );
  }

  /**
   * Handle STT partial result
   */
  private handleSttPartial(transcript: string): void {
    if (!this.currentTurn) return;
    
    if (!this.currentTurn.sttStarted) {
      this.currentTurn.sttStarted = true;
      this.currentTurn.metrics.sttLatency = performance.now() - this.currentTurn.startTime;
    }
    
    this.interimTranscript = transcript;
    this.callbacks.onSttPartial?.(transcript);
    
    // Start LLM speculatively on high-confidence interim
    if (this.config.enableParallelStreaming && 
        !this.currentTurn.llmStarted &&
        transcript.length > 10) {
      
      // Calculate confidence based on transcript stability
      const confidence = this.calculateTranscriptConfidence(transcript);
      
      if (confidence >= this.config.interimConfidenceThreshold) {
        console.log('[Orchestrator] Starting speculative LLM on interim:', transcript);
        setTimeout(() => {
          if (!this.currentTurn?.sttCompleted) {
            this.startLLMStreaming(transcript, 'interim');
          }
        }, this.config.llmStreamingDelay);
      }
    }
  }

  /**
   * Handle STT final result
   */
  private handleSttFinal(transcript: string, sessionId: string): void {
    if (!this.currentTurn) return;
    
    this.currentTurn.sttCompleted = true;
    this.currentTranscript = transcript;
    this.callbacks.onSttFinal?.(transcript);
    
    // Add to conversation memory
    conversationMemory.addUserMessage(sessionId, transcript);
    
    // Analyze intent
    const conversationHistory = conversationMemory.getMessages(sessionId).map(m => m.content);
    const intentResult = this.intentAnalyzer.analyzeIntent(transcript, conversationHistory);
    
    console.log('[Orchestrator] Intent:', intentResult.intent, 'Confidence:', intentResult.confidence);
    
    // Start or update LLM streaming
    if (!this.currentTurn.llmStarted) {
      this.startLLMStreaming(transcript, 'final', intentResult);
    } else if (this.interimTranscript !== transcript) {
      // Update LLM if transcript changed significantly
      console.log('[Orchestrator] Updating LLM with final transcript');
      this.updateLLMStreaming(transcript);
    }
  }

  /**
   * Start LLM streaming
   */
  private async startLLMStreaming(
    transcript: string,
    source: 'interim' | 'final',
    intentResult?: any
  ): Promise<void> {
    if (!this.currentTurn || this.currentTurn.llmStarted) return;
    
    this.currentTurn.llmStarted = true;
    this.llmAbortController = new AbortController();
    this.llmBuffer = '';
    
    try {
      // Prepare messages with intent context
      const messages = this.prepareMessages(transcript, intentResult);
      
      // Use optimized model settings for speed
      const stream = await this.openaiClient.chat.completions.create({
        model: 'gpt-4o-mini', // Fast model
        messages: messages as any,
        temperature: 0,
        max_tokens: 150,      // Limit response length for speed
        stream: true,
        // @ts-ignore - OpenAI types don't include these yet
        stream_options: {
          include_usage: false
        }
      });
      
      let firstToken = true;
      let fullResponse = '';
      
      for await (const chunk of stream) {
        if (this.llmAbortController?.signal.aborted) break;
        
        const content = chunk.choices?.[0]?.delta?.content ?? '';
        if (content) {
          if (firstToken) {
            firstToken = false;
            if (this.currentTurn) {
              this.currentTurn.metrics.llmFirstTokenLatency = 
                performance.now() - this.currentTurn.startTime;
            }
          }
          
          fullResponse += content;
          this.llmBuffer += content;
          this.callbacks.onLlmPartial?.(content);
          
          // Start TTS streaming when we have enough content
          if (this.config.enableParallelStreaming && 
              !this.currentTurn?.ttsStarted &&
              this.shouldStartTTS(fullResponse)) {
            this.startTTSStreaming(fullResponse, false);
          }
        }
      }
      
      if (this.currentTurn) {
        this.currentTurn.llmCompleted = true;
        this.currentTurn.metrics.llmCompleteLatency = 
          performance.now() - this.currentTurn.startTime;
      }
      
      this.callbacks.onLlmFinal?.(fullResponse);
      
      // Start TTS if not already started
      if (this.currentTurn && !this.currentTurn.ttsStarted) {
        this.startTTSStreaming(fullResponse, true);
      }
      
    } catch (error) {
      console.error('[Orchestrator] LLM streaming error:', error);
    }
  }

  /**
   * Update LLM streaming with corrected transcript
   */
  private updateLLMStreaming(transcript: string): void {
    // In production, this would update the LLM context
    // For now, we'll let the current stream complete
    console.log('[Orchestrator] LLM update requested but continuing current stream');
  }

  /**
   * Start TTS streaming
   */
  private async startTTSStreaming(text: string, isFinal: boolean): Promise<void> {
    if (!this.currentTurn || this.currentTurn.ttsStarted) return;
    
    this.currentTurn.ttsStarted = true;
    this.ttsAbortController = new AbortController();
    
    // Get voice configuration
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const voiceId = process.env.VOICE_ID || 'KYiVPerWcenyBTIvWbfY';
    
    if (!apiKey || !voiceId) {
      console.warn('[Orchestrator] TTS not configured');
      return;
    }
    
    try {
      let firstChunk = true;
      await streamElevenLabsTTS({
        apiKey,
        voiceId,
        text,
        optimizeStreamingLatency: 2, // Lower latency setting
        onChunk: (chunk) => {
          if (firstChunk) {
            firstChunk = false;
            if (this.currentTurn) {
              this.currentTurn.metrics.ttsFirstChunkLatency = 
                performance.now() - this.currentTurn.startTime;
            }
          }
          this.callbacks.onTtsChunk?.(chunk);
        },
        onEnd: (reason) => {
          if (this.currentTurn) {
            this.currentTurn.ttsCompleted = true;
            this.currentTurn.metrics.totalLatency = 
              performance.now() - this.currentTurn.startTime;
            
            // Report metrics
            this.callbacks.onMetrics?.(this.currentTurn.metrics);
            
            // Save turn to history
            this.turnHistory.push(this.currentTurn);
            if (this.turnHistory.length > 10) {
              this.turnHistory.shift();
            }
          }
          this.callbacks.onTtsEnd?.(reason);
        },
        signal: this.ttsAbortController.signal
      });
    } catch (error) {
      console.error('[Orchestrator] TTS streaming error:', error);
    }
  }

  /**
   * Determine if we should start TTS
   */
  private shouldStartTTS(text: string): boolean {
    // Start TTS when we have a complete sentence or enough content
    const hasSentenceEnd = /[.!?]/.test(text);
    const hasEnoughWords = text.split(/\s+/).length >= 5;
    const hasClauseEnd = /[,;:]/.test(text);
    
    return hasSentenceEnd || (hasEnoughWords && hasClauseEnd);
  }

  /**
   * Calculate transcript confidence
   */
  private calculateTranscriptConfidence(transcript: string): number {
    // Simple heuristic based on transcript characteristics
    let confidence = 0.5;
    
    // Longer transcripts are more stable
    if (transcript.length > 20) confidence += 0.2;
    if (transcript.length > 50) confidence += 0.1;
    
    // Complete sentences are more confident
    if (/[.!?]$/.test(transcript)) confidence += 0.2;
    
    // Multiple words indicate stability
    const wordCount = transcript.split(/\s+/).length;
    if (wordCount > 3) confidence += 0.1;
    if (wordCount > 5) confidence += 0.1;
    
    return Math.min(confidence, 1.0);
  }

  /**
   * Prepare messages for LLM
   */
  private prepareMessages(transcript: string, intentResult?: any): unknown[] {
    const messages = [];
    
    // System message with intent context
    let systemPrompt = 'You are InsureBot, an AI insurance assistant. Be helpful and conversational.';
    if (intentResult && intentResult.confidence > 0.7) {
      systemPrompt += `\n[Intent: ${intentResult.intent}]`;
      if (intentResult.suggestedResponse) {
        systemPrompt += `\n[Context: ${intentResult.suggestedResponse}]`;
      }
    }
    messages.push({ role: 'system', content: systemPrompt });
    
    // Add recent conversation history (keep it short for speed)
    const recentMessages = conversationMemory.getMessages('current').slice(-4);
    messages.push(...recentMessages);
    
    // Add current user message
    messages.push({ role: 'user', content: transcript });
    
    return messages;
  }

  /**
   * Interrupt current turn
   */
  interruptTurn(): void {
    if (!this.currentTurn) return;
    
    console.log('[Orchestrator] Interrupting turn:', this.currentTurn.id);
    this.currentTurn.interrupted = true;
    this.currentTurn.metrics.interrupted = true;
    
    // Abort ongoing streams
    this.llmAbortController?.abort();
    this.ttsAbortController?.abort();
    
    // Reset state
    this.currentTranscript = '';
    this.interimTranscript = '';
    this.llmBuffer = '';
  }

  /**
   * Send audio to STT
   */
  sendAudio(audioData: Buffer): void {
    this.deepgramManager.sendAudio(audioData);
  }

  /**
   * Set callbacks
   */
  setCallbacks(callbacks: typeof this.callbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Get average metrics
   */
  getAverageMetrics(): PipelineMetrics {
    if (this.turnHistory.length === 0) {
      return {
        sttLatency: 0,
        llmFirstTokenLatency: 0,
        llmCompleteLatency: 0,
        ttsFirstChunkLatency: 0,
        totalLatency: 0,
        interrupted: false
      };
    }
    
    const sum = this.turnHistory.reduce((acc, turn) => ({
      sttLatency: acc.sttLatency + turn.metrics.sttLatency,
      llmFirstTokenLatency: acc.llmFirstTokenLatency + turn.metrics.llmFirstTokenLatency,
      llmCompleteLatency: acc.llmCompleteLatency + turn.metrics.llmCompleteLatency,
      ttsFirstChunkLatency: acc.ttsFirstChunkLatency + turn.metrics.ttsFirstChunkLatency,
      totalLatency: acc.totalLatency + turn.metrics.totalLatency,
      interrupted: false
    }), {
      sttLatency: 0,
      llmFirstTokenLatency: 0,
      llmCompleteLatency: 0,
      ttsFirstChunkLatency: 0,
      totalLatency: 0,
      interrupted: false
    });
    
    const count = this.turnHistory.length;
    return {
      sttLatency: sum.sttLatency / count,
      llmFirstTokenLatency: sum.llmFirstTokenLatency / count,
      llmCompleteLatency: sum.llmCompleteLatency / count,
      ttsFirstChunkLatency: sum.ttsFirstChunkLatency / count,
      totalLatency: sum.totalLatency / count,
      interrupted: false
    };
  }

  /**
   * Cleanup
   */
  destroy(): void {
    this.interruptTurn();
    this.deepgramManager.closeConnection();
  }
}