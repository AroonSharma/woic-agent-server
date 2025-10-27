/**
 * Advanced Turn Detection System
 * Combines VAD + Semantic Analysis + Timing for Natural Conversation
 * Based on industry research from LiveKit, OpenAI, and ChatGPT Advanced Voice Mode
 */

import { SentenceDetector } from './utils/sentence-detector';

export interface TurnDetectionConfig {
  // VAD-based timing (critical for natural conversation)
  endOfTurnSilence: number;        // 600ms silence = user finished speaking
  minSpeechDuration: number;       // 300ms minimum to count as speech
  maxSpeechDuration: number;       // 15s max before forcing turn
  
  // STT confidence requirements
  minConfidenceThreshold: number;  // 0.8 minimum confidence for processing
  
  // Semantic analysis
  enableSemanticAnalysis: boolean; // Use sentence detector
  semanticConfidenceWeight: number; // How much to trust semantic analysis
  
  // Interruption handling
  bargeInEnabled: boolean;         // Allow user to interrupt agent
  bargeInThreshold: number;        // 500ms into TTS before allowing interruption
}

export interface TurnState {
  userSpeaking: boolean;           // User is actively speaking (VAD)
  userThinking: boolean;           // User paused but likely continuing
  agentSpeaking: boolean;          // Agent is generating TTS
  turnOwner: 'user' | 'agent' | 'neither';
  lastActivity: number;            // Timestamp of last activity
  currentTranscript: string;       // Current partial transcript
  confidence: number;              // Overall confidence in current state
}

export interface TurnDecision {
  action: 'wait' | 'process' | 'interrupt' | 'continue';
  confidence: number;
  reasons: string[];
  waitDuration?: number;           // How long to wait if action is 'wait'
  metadata: {
    vadActive: boolean;
    semanticComplete: boolean;
    silenceDuration: number;
    speechDuration: number;
  };
}

export class TurnDetector {
  private config: TurnDetectionConfig;
  private sentenceDetector: SentenceDetector;
  private state: TurnState;
  
  // Timing tracking
  private speechStartTime: number = 0;
  private lastSpeechTime: number = 0;
  private lastSilenceTime: number = 0;
  private agentStartTime: number = 0;
  
  // Speech activity buffers
  private recentUtterances: string[] = [];
  private vadHistory: boolean[] = []; // Rolling VAD history for smoothing
  
  constructor(config: Partial<TurnDetectionConfig> = {}) {
    this.config = {
      // Research-based optimal values
      endOfTurnSilence: 600,           // 600ms = sweet spot for natural conversation
      minSpeechDuration: 300,          // Filter out noise/clicks
      maxSpeechDuration: 15000,        // Force turn after 15s monologue
      minConfidenceThreshold: 0.75,    // Require high STT confidence
      enableSemanticAnalysis: true,    // Use intelligent sentence detection
      semanticConfidenceWeight: 0.7,   // Weight semantic analysis highly
      bargeInEnabled: true,            // Allow natural interruptions
      bargeInThreshold: 500,           // Wait 500ms before allowing interruption
      ...config
    };
    
    this.sentenceDetector = new SentenceDetector();
    this.state = this.createInitialState();
  }
  
  /**
   * Main decision function - called on every audio event
   */
  decideTurn(
    vadActive: boolean,
    transcript: string,
    confidence: number,
    timestamp: number = Date.now()
  ): TurnDecision {
    
    // Update VAD history for smoothing
    this.updateVadHistory(vadActive);
    const smoothedVad = this.getSmoothedVad();
    
    // Update timing tracking
    this.updateTimingState(smoothedVad, timestamp);
    
    // Calculate durations
    const silenceDuration = smoothedVad ? 0 : (timestamp - this.lastSpeechTime);
    const speechDuration = this.speechStartTime > 0 ? (timestamp - this.speechStartTime) : 0;
    
    // Update turn state
    this.state.userSpeaking = smoothedVad;
    this.state.currentTranscript = transcript;
    this.state.confidence = confidence;
    this.state.lastActivity = timestamp;
    
    const reasons: string[] = [];
    let action: TurnDecision['action'] = 'wait';
    let decisionConfidence = 0;
    let waitDuration = this.config.endOfTurnSilence;
    
    // 1. Check if user is clearly still speaking
    if (smoothedVad && speechDuration < this.config.maxSpeechDuration) {
      reasons.push('user_actively_speaking');
      action = 'wait';
      decisionConfidence = 0.9;
      this.state.userThinking = false;
      this.state.turnOwner = 'user';
    }
    
    // 2. Check for forced turn due to max speech duration
    else if (speechDuration > this.config.maxSpeechDuration) {
      reasons.push('max_speech_duration_reached');
      action = 'process';
      decisionConfidence = 1.0;
      this.state.turnOwner = 'agent';
    }
    
    // 3. Check for insufficient speech duration (noise filtering)
    else if (speechDuration < this.config.minSpeechDuration && silenceDuration > 100) {
      reasons.push('insufficient_speech_duration');
      action = 'wait';
      decisionConfidence = 0.8;
      waitDuration = 200; // Short wait for noise
    }
    
    // 4. Check STT confidence
    else if (confidence < this.config.minConfidenceThreshold) {
      reasons.push('low_stt_confidence');
      action = 'wait';
      decisionConfidence = 0.6;
      waitDuration = Math.min(this.config.endOfTurnSilence, silenceDuration + 200);
    }
    
    // 5. Semantic analysis (if enabled)
    else if (this.config.enableSemanticAnalysis && transcript.trim()) {
      const semanticAnalysis = this.sentenceDetector.analyzeSentence(transcript, silenceDuration);
      
      if (semanticAnalysis.suggestion === 'wait_longer') {
        reasons.push('semantic_analysis_incomplete', ...semanticAnalysis.reasons);
        action = 'wait';
        decisionConfidence = Math.max(0.3, semanticAnalysis.confidence / 100);
        waitDuration = Math.min(this.config.endOfTurnSilence * 1.5, silenceDuration + 800);
        this.state.userThinking = true;
      } else if (semanticAnalysis.suggestion === 'process') {
        reasons.push('semantic_analysis_complete', ...semanticAnalysis.reasons);
        action = 'process';
        decisionConfidence = Math.min(0.95, semanticAnalysis.confidence / 100 + 0.2);
        this.state.turnOwner = 'agent';
      } else {
        // 'wait' suggestion
        reasons.push('semantic_analysis_uncertain', ...semanticAnalysis.reasons);
        action = 'wait';
        decisionConfidence = Math.max(0.4, semanticAnalysis.confidence / 100);
        waitDuration = this.config.endOfTurnSilence;
        this.state.userThinking = true;
      }
    }
    
    // 6. Time-based decision (fallback)
    else if (silenceDuration > this.config.endOfTurnSilence) {
      reasons.push('silence_duration_exceeded');
      action = 'process';
      decisionConfidence = 0.8;
      this.state.turnOwner = 'agent';
    }
    
    // 7. Check for barge-in (user interrupting agent)
    if (this.state.agentSpeaking && smoothedVad && 
        (timestamp - this.agentStartTime) > this.config.bargeInThreshold) {
      reasons.push('user_barge_in_detected');
      action = 'interrupt';
      decisionConfidence = 0.9;
      this.state.turnOwner = 'user';
    }
    
    // Update turn owner based on decision
    if (action === 'process') {
      this.state.turnOwner = 'agent';
      this.state.userThinking = false;
    } else if (action === 'wait' && smoothedVad) {
      this.state.turnOwner = 'user';
    }
    
    return {
      action,
      confidence: decisionConfidence,
      reasons,
      waitDuration: action === 'wait' ? waitDuration : undefined,
      metadata: {
        vadActive: smoothedVad,
        semanticComplete: this.config.enableSemanticAnalysis ? 
          this.sentenceDetector.analyzeSentence(transcript, silenceDuration).isComplete : false,
        silenceDuration,
        speechDuration
      }
    };
  }
  
  /**
   * Notify when agent starts speaking
   */
  onAgentStartSpeaking(timestamp: number = Date.now()): void {
    this.state.agentSpeaking = true;
    this.state.turnOwner = 'agent';
    this.agentStartTime = timestamp;
    
    // Store recent utterance for adaptive learning
    if (this.state.currentTranscript.trim()) {
      this.recentUtterances.push(this.state.currentTranscript.trim());
      if (this.recentUtterances.length > 10) {
        this.recentUtterances.shift(); // Keep last 10 utterances
      }
    }
  }
  
  /**
   * Notify when agent stops speaking
   */
  onAgentStopSpeaking(timestamp: number = Date.now()): void {
    this.state.agentSpeaking = false;
    this.state.turnOwner = 'neither';
    this.agentStartTime = 0;
  }
  
  /**
   * Get current turn state
   */
  getTurnState(): TurnState {
    return { ...this.state };
  }
  
  /**
   * Reset turn detector state
   */
  reset(): void {
    this.state = this.createInitialState();
    this.speechStartTime = 0;
    this.lastSpeechTime = 0;
    this.lastSilenceTime = 0;
    this.agentStartTime = 0;
    this.vadHistory = [];
  }
  
  /**
   * Get adaptive timeout based on user's speaking patterns
   */
  getAdaptiveTimeout(): number {
    if (this.recentUtterances.length === 0) {
      return this.config.endOfTurnSilence;
    }
    
    return this.sentenceDetector.getAdaptiveTimeout(this.recentUtterances);
  }
  
  // Private helper methods
  private createInitialState(): TurnState {
    return {
      userSpeaking: false,
      userThinking: false,
      agentSpeaking: false,
      turnOwner: 'neither',
      lastActivity: Date.now(),
      currentTranscript: '',
      confidence: 0
    };
  }
  
  private updateVadHistory(vadActive: boolean): void {
    this.vadHistory.push(vadActive);
    if (this.vadHistory.length > 5) {
      this.vadHistory.shift(); // Keep last 5 VAD readings for smoothing
    }
  }
  
  private getSmoothedVad(): boolean {
    if (this.vadHistory.length === 0) return false;
    
    // Require majority of recent readings to be active to smooth out noise
    const activeCount = this.vadHistory.filter(active => active).length;
    return activeCount >= Math.ceil(this.vadHistory.length / 2);
  }
  
  private updateTimingState(vadActive: boolean, timestamp: number): void {
    if (vadActive) {
      if (this.speechStartTime === 0) {
        this.speechStartTime = timestamp;
      }
      this.lastSpeechTime = timestamp;
    } else {
      if (this.lastSilenceTime === 0 && this.speechStartTime > 0) {
        this.lastSilenceTime = timestamp;
      }
    }
    
    // Reset speech timing if silence was very long (new utterance)
    if (!vadActive && (timestamp - this.lastSpeechTime) > this.config.endOfTurnSilence * 2) {
      this.speechStartTime = 0;
    }
  }
}

// Default configuration for different use cases
export const TURN_DETECTION_PRESETS = {
  // Responsive mode - quick turn-taking (like customer service)
  responsive: {
    endOfTurnSilence: 400,
    minSpeechDuration: 200,
    enableSemanticAnalysis: false,
    bargeInThreshold: 300
  },
  
  // Natural mode - allows thinking pauses (like therapy/coaching)
  natural: {
    endOfTurnSilence: 800,
    minSpeechDuration: 400,
    enableSemanticAnalysis: true,
    semanticConfidenceWeight: 0.8,
    bargeInThreshold: 700
  },
  
  // Patient mode - very long pauses allowed (like interviews)
  patient: {
    endOfTurnSilence: 1200,
    minSpeechDuration: 500,
    maxSpeechDuration: 30000,
    enableSemanticAnalysis: true,
    semanticConfidenceWeight: 0.9,
    bargeInThreshold: 1000
  }
};