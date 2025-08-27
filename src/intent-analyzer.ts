/**
 * Intent Analysis System
 * Industry-standard NLU pipeline for voice agents
 */

export interface IntentResult {
  intent: string;
  confidence: number;
  entities: Record<string, any>;
  context: string;
  requiresAction: boolean;
  suggestedResponse?: string;
}

export interface Entity {
  name: string;
  value: string;
  confidence: number;
  start?: number;
  end?: number;
}

// Domain-specific intent definitions for insurance
const INSURANCE_INTENTS = {
  // Customer identification
  'customer.identification.new': {
    patterns: [
      /\b(new|first\s+time|never\s+had|don't\s+have|no\s+policy)\b/i,
      /\b(want\s+to\s+buy|looking\s+for|need|interested\s+in)\s+(insurance|policy|coverage)\b/i,
    ],
    entities: ['coverage_type', 'personal_info'],
    confidence_threshold: 0.8,
    action_required: true,
  },
  'customer.identification.existing': {
    patterns: [
      /\b(existing|current|have\s+a?\s+policy|policy\s+holder|already\s+have)\b/i,
      /\b(my\s+policy|account|claim|renewal)\b/i,
    ],
    entities: ['policy_number', 'personal_info'],
    confidence_threshold: 0.8,
    action_required: true,
  },

  // Policy inquiries
  'policy.inquiry.coverage': {
    patterns: [
      /\b(what\s+does|what's\s+covered|coverage|benefits|includes)\b/i,
      /\b(covered\s+for|protection|deductible)\b/i,
    ],
    entities: ['coverage_type', 'policy_details'],
    confidence_threshold: 0.7,
    action_required: false,
  },
  'policy.inquiry.premium': {
    patterns: [
      /\b(cost|price|premium|monthly|yearly|payment|how\s+much)\b/i,
      /\b(affordable|expensive|rates)\b/i,
    ],
    entities: ['amount', 'period'],
    confidence_threshold: 0.7,
    action_required: false,
  },

  // Claims
  'claim.report': {
    patterns: [
      /\b(claim|accident|incident|damage|loss|stolen)\b/i,
      /\b(file\s+a\s+claim|report|happened|occurred)\b/i,
    ],
    entities: ['incident_type', 'date', 'location', 'amount'],
    confidence_threshold: 0.9,
    action_required: true,
  },
  'claim.status': {
    patterns: [
      /\b(claim\s+status|where\s+is\s+my\s+claim|claim\s+number)\b/i,
      /\b(processing|approved|denied|pending)\b/i,
    ],
    entities: ['claim_number', 'policy_number'],
    confidence_threshold: 0.8,
    action_required: false,
  },

  // Contact and support
  'support.agent': {
    patterns: [
      /\b(speak\s+to|talk\s+to|connect\s+me|human|agent|representative)\b/i,
      /\b(can't\s+help|don't\s+understand|frustrated)\b/i,
    ],
    entities: [],
    confidence_threshold: 0.9,
    action_required: true,
  },
  'greeting.hello': {
    patterns: [
      /\b(hello|hi|hey|good\s+(morning|afternoon|evening))\b/i,
    ],
    entities: [],
    confidence_threshold: 0.6,
    action_required: false,
  },

  // Generic fallback
  'unknown': {
    patterns: [],
    entities: [],
    confidence_threshold: 0.0,
    action_required: false,
  },
};

// Entity extraction patterns
const ENTITY_PATTERNS = {
  policy_number: /\b[A-Z]{2,4}\d{6,12}\b/i,
  claim_number: /\b(claim|ref|reference)?\s*#?\s*([A-Z0-9]{6,15})\b/i,
  phone_number: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/,
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/,
  amount: /\$?\d{1,3}(?:,?\d{3})*(?:\.\d{2})?/,
  date: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(yesterday|today|tomorrow)\b/i,
  coverage_type: /\b(auto|car|home|life|health|dental|vision|disability)\s*(insurance|coverage)?\b/i,
};

export class IntentAnalyzer {
  private conversationContext: string[] = [];
  private lastIntent: string | null = null;
  private entityHistory: Record<string, any> = {};

  /**
   * Analyze user transcript for intent and entities
   */
  analyzeIntent(transcript: string, conversationHistory: string[] = []): IntentResult {
    const normalizedText = transcript.toLowerCase().trim();
    
    console.log('[intent] Analyzing transcript:', transcript);
    
    // Extract entities first
    const entities = this.extractEntities(transcript);
    
    // Pattern-based intent detection (fast, reliable)
    const patternIntent = this.detectPatternIntent(normalizedText);
    
    // Context-aware refinement
    const contextRefinedIntent = this.refineWithContext(patternIntent, normalizedText, conversationHistory);
    
    // Calculate final confidence
    const finalConfidence = this.calculateConfidence(contextRefinedIntent, entities, normalizedText);
    
    // Update conversation context
    this.updateContext(contextRefinedIntent.intent, entities);
    
    const result: IntentResult = {
      intent: contextRefinedIntent.intent,
      confidence: finalConfidence,
      entities,
      context: this.getContextSummary(),
      requiresAction: (INSURANCE_INTENTS as any)[contextRefinedIntent.intent]?.action_required || false,
      suggestedResponse: this.generateSuggestedResponse(contextRefinedIntent.intent, entities),
    };
    
    console.log('[intent] Analysis result:', result);
    return result;
  }

  private detectPatternIntent(text: string): { intent: string; confidence: number } {
    let bestMatch = { intent: 'unknown', confidence: 0.0 };
    
    for (const [intentName, config] of Object.entries(INSURANCE_INTENTS)) {
      if (intentName === 'unknown') continue;
      
      let matches = 0;
      let totalPatterns = config.patterns.length;
      
      if (totalPatterns === 0) continue;
      
      for (const pattern of config.patterns) {
        if (pattern.test(text)) {
          matches++;
        }
      }
      
      const confidence = matches / totalPatterns;
      
      if (confidence >= config.confidence_threshold && confidence > bestMatch.confidence) {
        bestMatch = { intent: intentName, confidence };
      }
    }
    
    return bestMatch;
  }

  private extractEntities(text: string): Record<string, Entity> {
    const entities: Record<string, Entity> = {};
    
    for (const [entityType, pattern] of Object.entries(ENTITY_PATTERNS)) {
      const matches = text.match(pattern);
      if (matches) {
        entities[entityType] = {
          name: entityType,
          value: matches[0],
          confidence: 0.9,
          start: text.indexOf(matches[0]),
          end: text.indexOf(matches[0]) + matches[0].length,
        };
      }
    }
    
    return entities;
  }

  private refineWithContext(
    baseIntent: { intent: string; confidence: number },
    text: string,
    conversationHistory: string[]
  ): { intent: string; confidence: number } {
    // Context-based refinements
    const recentHistory = conversationHistory.slice(-3).join(' ').toLowerCase();
    
    // If user just said they're existing but now giving policy details
    if (this.lastIntent === 'customer.identification.existing' && 
        /\b[A-Z]{2,4}\d{6,12}\b/.test(text)) {
      return { intent: 'customer.identification.existing', confidence: 0.95 };
    }
    
    // If conversation started with claims and user provides details
    if (recentHistory.includes('claim') && /\b\d+\b/.test(text)) {
      return { intent: 'claim.status', confidence: 0.9 };
    }
    
    // Short responses in context
    if (text.length < 10) {
      if (this.lastIntent?.includes('customer.identification')) {
        if (/\b(existing|current|yes|have)\b/i.test(text)) {
          return { intent: 'customer.identification.existing', confidence: 0.85 };
        }
        if (/\b(new|no|first|never)\b/i.test(text)) {
          return { intent: 'customer.identification.new', confidence: 0.85 };
        }
      }
    }
    
    return baseIntent;
  }

  private calculateConfidence(
    intent: { intent: string; confidence: number },
    entities: Record<string, Entity>,
    text: string
  ): number {
    let confidence = intent.confidence;
    
    // Boost confidence based on entities
    const intentConfig = (INSURANCE_INTENTS as any)[intent.intent];
    if (intentConfig?.entities) {
      const foundEntities = intentConfig.entities.filter((e: string) => entities[e]);
      const entityBoost = foundEntities.length / intentConfig.entities.length * 0.2;
      confidence = Math.min(1.0, confidence + entityBoost);
    }
    
    // Reduce confidence for very short or unclear inputs
    if (text.length < 5) {
      confidence *= 0.7;
    }
    
    return Math.round(confidence * 100) / 100;
  }

  private updateContext(intent: string, entities: Record<string, Entity>): void {
    this.lastIntent = intent;
    this.conversationContext.push(intent);
    
    // Keep only last 5 intents
    if (this.conversationContext.length > 5) {
      this.conversationContext.shift();
    }
    
    // Update entity history
    for (const [key, entity] of Object.entries(entities)) {
      this.entityHistory[key] = entity.value;
    }
  }

  private getContextSummary(): string {
    const recentIntents = this.conversationContext.slice(-3);
    return recentIntents.join(' → ');
  }

  private generateSuggestedResponse(intent: string, entities: Record<string, Entity>): string {
    const suggestions: Record<string, string> = {
      'customer.identification.new': 'Great! I can help you find the right insurance coverage. What type of insurance are you looking for?',
      'customer.identification.existing': 'Thank you for being a valued customer. How can I help you with your existing policy today?',
      'policy.inquiry.coverage': 'I\'d be happy to explain your coverage details. Let me pull up your policy information.',
      'policy.inquiry.premium': 'I can help you with pricing information. Let me get the details for you.',
      'claim.report': 'I\'m sorry to hear about your incident. Let me help you file a claim right away.',
      'claim.status': 'Let me check the status of your claim for you.',
      'support.agent': 'I understand you\'d like to speak with a specialist. Let me connect you with the right person.',
      'greeting.hello': 'Hello! I\'m here to help with all your insurance needs. Are you a new or existing customer?',
      'unknown': 'I want to make sure I understand correctly. Could you please rephrase that?',
    };
    
    return suggestions[intent] || suggestions['unknown'];
  }

  /**
   * Get current conversation state for external systems
   */
  getConversationState() {
    return {
      lastIntent: this.lastIntent,
      context: this.conversationContext,
      entities: this.entityHistory,
    };
  }

  /**
   * Reset conversation state (new session)
   */
  resetSession(): void {
    this.conversationContext = [];
    this.lastIntent = null;
    this.entityHistory = {};
  }
}