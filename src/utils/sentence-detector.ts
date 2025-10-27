/**
 * Intelligent sentence completion detection for voice agents
 * Based on real-world implementations from ChatGPT Advanced Voice Mode and Alexa
 */

export interface SentenceAnalysis {
  isComplete: boolean;
  confidence: number;
  reasons: string[];
  suggestion: 'wait' | 'process' | 'wait_longer';
}

export class SentenceDetector {
  private readonly SENTENCE_ENDINGS = /[.!?]$/;
  private readonly INCOMPLETE_PATTERNS = /\b(and|but|so|because|while|when|if|although|however|therefore|moreover|furthermore|meanwhile|then|after|before|since|unless|until|whereas)\s*$/i;
  private readonly QUESTION_STARTERS = /^(what|when|where|why|how|who|which|can|could|would|should|do|does|did|is|are|was|were|will|have|has|had)/i;
  private readonly INCOMPLETE_QUESTIONS = /^(what|when|where|why|how|who|which)\s+(?!.*[?]).*$/i;
  
  // Real-world patterns from voice agent research
  private readonly CONTINUATION_WORDS = [
    'and', 'but', 'so', 'because', 'while', 'when', 'if', 'although', 
    'however', 'therefore', 'moreover', 'furthermore', 'meanwhile', 
    'then', 'after', 'before', 'since', 'unless', 'until', 'whereas'
  ];

  analyzeSentence(text: string, silenceDurationMs: number = 0): SentenceAnalysis {
    const trimmed = text.trim();
    const reasons: string[] = [];
    let confidence = 0;
    let isComplete = false;

    if (!trimmed) {
      return { isComplete: false, confidence: 0, reasons: ['empty_text'], suggestion: 'wait' };
    }

    // 1. Check for obvious sentence endings
    if (this.SENTENCE_ENDINGS.test(trimmed)) {
      reasons.push('has_punctuation');
      confidence += 50; // Increased confidence for punctuated sentences
      isComplete = true;
    }

    // 2. Check for incomplete patterns - more aggressive detection
    if (this.INCOMPLETE_PATTERNS.test(trimmed)) {
      reasons.push('ends_with_conjunction');
      confidence -= 40; // More penalty for incomplete patterns
      isComplete = false;
    }

    // 3. Enhanced incomplete pattern detection
    const moreIncompletePatterns = /\b(the|a|an|this|that|these|those|my|your|his|her|our|their|some|many|few|all|no|every)\s*$/i;
    if (moreIncompletePatterns.test(trimmed)) {
      reasons.push('ends_with_article_or_determiner');
      confidence -= 35;
      isComplete = false;
    }

    // 4. Question analysis
    if (this.QUESTION_STARTERS.test(trimmed)) {
      if (this.INCOMPLETE_QUESTIONS.test(trimmed)) {
        reasons.push('incomplete_question');
        confidence -= 30; // More penalty for incomplete questions
        isComplete = false;
      } else if (trimmed.endsWith('?')) {
        reasons.push('complete_question');
        confidence += 40; // More confidence for complete questions
        isComplete = true;
      } else {
        // Question word without question mark or completion
        reasons.push('question_without_completion');
        confidence -= 25;
        isComplete = false;
      }
    }

    // 5. Word count heuristic - more conservative
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 4) { // Increased from 3 to 4
      reasons.push('too_short');
      confidence -= 25; // More penalty for short phrases
      isComplete = false;
    } else if (wordCount >= 6) { // Increased minimum for adequate length
      reasons.push('adequate_length');
      confidence += 15;
    }

    // 6. Silence duration analysis - more conservative thresholds
    if (silenceDurationMs > 2500) { // Increased from 2000ms
      reasons.push('very_long_silence');
      confidence += 30;
      isComplete = true;
    } else if (silenceDurationMs > 1800) { // Increased from 1000ms
      reasons.push('long_silence');
      confidence += 20;
    } else if (silenceDurationMs > 1200) {
      reasons.push('medium_silence');
      confidence += 5;
    } else if (silenceDurationMs < 800) { // Increased threshold
      reasons.push('short_silence');
      confidence -= 20; // More penalty for short silence
    }

    // 7. Context-aware patterns
    if (this.hasImplicitCompletion(trimmed)) {
      reasons.push('implicit_completion');
      confidence += 25;
      isComplete = true;
    }

    // 8. Enhanced fragment detection with more comprehensive patterns
    const fragmentPatterns = [
      // Intent fragments
      /^(i want to|i need to|i would like to|i'm going to|let me|can you|could you|would you|will you)\s*$/i,
      /^(i think|i believe|i feel|i know|i understand|i see|i hear|i remember)\s*$/i,
      /^(i have to|i should|i must|i might|i may|i will|i'll|i'd like to)\s*$/i,
      
      // Prepositional fragments
      /^(in the|on the|at the|for the|with the|by the|from the|to the)\s*$/i,
      /^(during the|before the|after the|under the|over the|through the)\s*$/i,
      
      // Existential fragments  
      /^(it is|it was|there is|there was|this is|that is)\s*$/i,
      /^(there are|there were|here is|here are)\s*$/i,
      
      // Incomplete conditionals and temporal phrases
      /^(if i|when i|while i|as i|since i|until i|unless i)\s*$/i,
      /^(because i|although i|even though|even if)\s*$/i,
      
      // Incomplete object references
      /^(the one|the person|the thing|the place|the time|the way)\s*$/i,
      
      // Partial verb phrases
      /^(i'm trying to|i'm planning to|i'm hoping to|i'm looking to)\s*$/i,
      /^(we need to|we should|we could|we might|we have to)\s*$/i,
      
      // Mid-sentence conjunctions standing alone
      /^(and then|but then|so then|or maybe|and also|but also)\s*$/i
    ];
    
    if (fragmentPatterns.some(pattern => pattern.test(trimmed))) {
      reasons.push('common_fragment');
      confidence -= 35; // Increased penalty
      isComplete = false;
    }

    // 8b. Check for incomplete comparative/superlative constructions
    const incompleteComparisons = [
      /\b(more|less|better|worse|bigger|smaller|faster|slower)\s*$/i,
      /\b(most|least|best|worst|biggest|smallest|fastest|slowest)\s*$/i,
      /\b(as\s+\w+\s+as)\s*$/i
    ];
    
    if (incompleteComparisons.some(pattern => pattern.test(trimmed))) {
      reasons.push('incomplete_comparison');
      confidence -= 25;
      isComplete = false;
    }

    // 8c. Detect incomplete lists or enumerations
    if (/\b(such as|including|like|for example)\s*$/i.test(trimmed)) {
      reasons.push('incomplete_enumeration');
      confidence -= 30;
      isComplete = false;
    }

    // 9. Final confidence calculation - more conservative baseline
    confidence = Math.max(0, Math.min(100, confidence + 40)); // Reduced baseline from 50 to 40

    // 10. Decision logic - balanced for speed + accuracy
    let suggestion: 'wait' | 'process' | 'wait_longer';
    
    // Fast processing for clearly complete sentences
    if (confidence >= 75 && isComplete) { // Reduced from 80 to 75
      suggestion = 'process';
    } 
    // Process moderate confidence with sufficient silence
    else if (confidence >= 60 && isComplete && silenceDurationMs > 1500) { // More responsive
      suggestion = 'process';
    } 
    // Wait longer only for very obvious incomplete patterns
    else if (confidence < 35 || (this.INCOMPLETE_PATTERNS.test(trimmed) && confidence < 50)) {
      suggestion = 'wait_longer';
    } 
    // Default wait for uncertain cases
    else {
      suggestion = 'wait';
    }

    return {
      isComplete,
      confidence,
      reasons,
      suggestion
    };
  }

  private hasImplicitCompletion(text: string): boolean {
    // Common complete phrases that don't need punctuation
    const completePatterns = [
      /^(yes|no|okay|ok|sure|absolutely|definitely|exactly|right|correct|true|false|maybe|perhaps)$/i,
      /^(hello|hi|hey|goodbye|bye|thanks|thank you|please|excuse me|sorry)$/i,
      /^(i (want|need|like|love|hate|prefer|think|believe|know|understand)).*$/i,
      /^(can you|could you|would you|will you|do you|are you|is it|what about).*$/i
    ];

    return completePatterns.some(pattern => pattern.test(text.trim()));
  }

  // Adaptive thresholds based on user speaking patterns
  getAdaptiveTimeout(recentUtterances: string[]): number {
    const avgLength = recentUtterances.length > 0 
      ? recentUtterances.reduce((sum, u) => sum + u.split(' ').length, 0) / recentUtterances.length
      : 5;

    // Longer average utterances = longer timeout
    if (avgLength > 10) return 2500; // Complex speaker
    if (avgLength > 6) return 2000;  // Average speaker  
    return 1500; // Concise speaker
  }
}