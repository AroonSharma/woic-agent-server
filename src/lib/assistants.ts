// Assistant Configuration Schema and Management
export interface Assistant {
  id: string;
  name: string;
  description?: string;
  status: 'active' | 'paused' | 'draft';
  
  // Voice Configuration
  voice: {
    provider: 'elevenlabs' | 'openai' | 'azure' | 'playht';
    voiceId: string;
    voiceName?: string;
    model?: string; // e.g., 'eleven_turbo_v2_5'
    settings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
    };
  };
  
  // Model Configuration
  model: {
    provider: 'openai' | 'anthropic' | 'google';
    model: string; // e.g., 'gpt-4o-mini', 'claude-3-sonnet'
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
  
  // Conversation Configuration
  systemPrompt: string;
  firstMessage?: string;
  firstMessageMode?: 'assistant_speaks_first' | 'user_speaks_first' | 'wait_for_user';
  
  // STT Configuration
  transcriber?: {
    provider: 'deepgram' | 'azure' | 'google';
    model?: string;
    language?: string;
    smartFormat?: boolean;
  };
  
  // Endpointing Configuration
  endpointing?: {
    waitSeconds: number;
    punctuationSeconds: number;
    noPunctSeconds: number;
    numberSeconds: number;
    smartEndpointing: boolean;
  };
  
  // Advanced Settings
  vadEnabled?: boolean;
  vadPolicy?: 'none' | 'basic' | 'aggressive';
  interruptible?: boolean;
  
  // Metadata
  createdAt: Date;
  updatedAt: Date;
  lastUsed?: Date;
  callCount?: number;
  totalDuration?: number;
  totalCost?: number;
}

// Default assistants for demo
export const DEFAULT_ASSISTANTS: Assistant[] = [
  {
    id: 'sbi-insurance-assistant',
    name: 'SBI Insurance Assistant',
    description: 'AI assistant for SBI General Insurance customers',
    status: 'active',
    voice: {
      provider: 'elevenlabs',
      voiceId: 'KYiVPerWcenyBTIvWbfY', // Mahi
      voiceName: 'Mahi',
      model: 'eleven_turbo_v2_5',
      settings: {
        stability: 0.5,
        similarityBoost: 0.75,
      }
    },
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0,
    },
    systemPrompt: `You are InsureBot, an AI insurance assistant for SBI General Insurance. Your voice agent is Mahi. You help customers with policy inquiries, claims processing, and insurance guidance.

CONVERSATION FLOW:
1. Greet warmly and ask if they're an existing customer or need new policy information
2. For existing customers: Ask for policy number, then assist with:
   - Policy details and coverage
   - Premium payment status
   - Claims status and filing
   - Policy renewals
   - Beneficiary updates
3. For new customers: Guide them through:
   - Insurance needs assessment
   - Product recommendations (auto, health, home, life)
   - Premium calculations
   - Application process

KNOWLEDGE BASE:
- Auto Insurance: Third-party mandatory, comprehensive coverage options
- Health Insurance: Individual, family floater, senior citizen plans
- Home Insurance: Structure, contents, natural disasters coverage
- Life Insurance: Term, whole life, endowment plans
- Claims Process: 24/7 helpline, online filing, document requirements

TONE: Professional yet friendly, helpful, and patient. Keep responses concise but informative. Always offer to connect to human agents for complex issues.`,
    firstMessage: "Hello! Welcome to SBI General Insurance. I'm Mahi, your AI assistant. Are you an existing customer or would you like to learn about our insurance products?",
    firstMessageMode: 'assistant_speaks_first',
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
    },
    endpointing: {
      waitSeconds: 0.4,
      punctuationSeconds: 0.1,
      noPunctSeconds: 1.5,
      numberSeconds: 0.5,
      smartEndpointing: false,
    },
    vadEnabled: true,
    vadPolicy: 'basic',
    interruptible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    callCount: 0,
    totalDuration: 0,
    totalCost: 0,
  },
  {
    id: 'customer-support-bot',
    name: 'Customer Support Bot',
    description: 'General customer support assistant',
    status: 'active',
    voice: {
      provider: 'elevenlabs',
      voiceId: '21m00Tcm4TlvDq8ikWAM', // Rachel (professional female voice)
      voiceName: 'Rachel',
      model: 'eleven_turbo_v2_5',
      settings: {
        stability: 0.7,
        similarityBoost: 0.8,
      }
    },
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.3,
    },
    systemPrompt: `You are a friendly and professional customer support assistant. Your name is Rachel. You help customers with their inquiries, resolve issues, and provide information about products and services.

CORE RESPONSIBILITIES:
1. Answer customer questions promptly and accurately
2. Troubleshoot common issues
3. Guide customers through processes
4. Escalate complex issues when needed

CONVERSATION STYLE:
- Be empathetic and understanding
- Keep responses clear and concise
- Confirm understanding before proceeding
- Always offer additional help

Remember: Customer satisfaction is your top priority. Be patient, helpful, and professional at all times.`,
    firstMessage: "Hello! I'm Rachel from customer support. How can I assist you today?",
    firstMessageMode: 'assistant_speaks_first',
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
    },
    endpointing: {
      waitSeconds: 0.5,
      punctuationSeconds: 0.15,
      noPunctSeconds: 1.2,
      numberSeconds: 0.4,
      smartEndpointing: false,
    },
    vadEnabled: true,
    vadPolicy: 'basic',
    interruptible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    callCount: 0,
    totalDuration: 0,
    totalCost: 0,
  },
  {
    id: 'sales-assistant',
    name: 'Sales Assistant',
    description: 'Proactive sales and lead qualification bot',
    status: 'draft',
    voice: {
      provider: 'elevenlabs',
      voiceId: 'pNInz6obpgDQGcFmaJgB', // Adam (confident male voice)
      voiceName: 'Adam',
      model: 'eleven_turbo_v2_5',
      settings: {
        stability: 0.6,
        similarityBoost: 0.85,
      }
    },
    model: {
      provider: 'openai',
      model: 'gpt-4o-mini',
      temperature: 0.7,
    },
    systemPrompt: `You are Adam, a professional sales assistant. Your goal is to qualify leads, understand customer needs, and guide them toward the right solutions.

SALES APPROACH:
1. Build rapport with a friendly greeting
2. Ask open-ended questions to understand needs
3. Listen actively and show genuine interest
4. Present relevant solutions based on their needs
5. Handle objections professionally
6. Guide toward next steps

KEY BEHAVIORS:
- Be enthusiastic but not pushy
- Focus on value, not just features
- Use social proof when appropriate
- Always be honest and transparent
- Know when to involve human sales team

Remember: Your goal is to help customers find the right solution, not to push unnecessary products.`,
    firstMessage: "Hi there! I'm Adam. I'm here to help you find the perfect solution for your needs. What brings you here today?",
    firstMessageMode: 'assistant_speaks_first',
    transcriber: {
      provider: 'deepgram',
      model: 'nova-2',
      language: 'en',
      smartFormat: true,
    },
    endpointing: {
      waitSeconds: 0.3,
      punctuationSeconds: 0.1,
      noPunctSeconds: 1.8,
      numberSeconds: 0.6,
      smartEndpointing: true,
    },
    vadEnabled: true,
    vadPolicy: 'aggressive',
    interruptible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    callCount: 0,
    totalDuration: 0,
    totalCost: 0,
  }
];

// In-memory storage (replace with database in production)
let assistants: Assistant[] = [...DEFAULT_ASSISTANTS];

// Assistant Management Functions
export const assistantManager = {
  // Get all assistants
  getAll: async (): Promise<Assistant[]> => {
    return assistants;
  },

  // Get assistant by ID
  getById: async (id: string): Promise<Assistant | null> => {
    return assistants.find(a => a.id === id) || null;
  },

  // Create new assistant
  create: async (assistant: Omit<Assistant, 'id' | 'createdAt' | 'updatedAt'>): Promise<Assistant> => {
    const newAssistant: Assistant = {
      ...assistant,
      id: `assistant_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    assistants.push(newAssistant);
    return newAssistant;
  },

  // Update assistant
  update: async (id: string, updates: Partial<Assistant>): Promise<Assistant | null> => {
    const index = assistants.findIndex(a => a.id === id);
    if (index === -1) return null;
    
    assistants[index] = {
      ...assistants[index],
      ...updates,
      id: assistants[index].id, // Prevent ID change
      updatedAt: new Date(),
    };
    return assistants[index];
  },

  // Delete assistant
  delete: async (id: string): Promise<boolean> => {
    const index = assistants.findIndex(a => a.id === id);
    if (index === -1) return false;
    
    assistants.splice(index, 1);
    return true;
  },

  // Update usage stats
  updateUsageStats: async (id: string, duration: number, cost: number): Promise<void> => {
    const assistant = assistants.find(a => a.id === id);
    if (assistant) {
      assistant.callCount = (assistant.callCount || 0) + 1;
      assistant.totalDuration = (assistant.totalDuration || 0) + duration;
      assistant.totalCost = (assistant.totalCost || 0) + cost;
      assistant.lastUsed = new Date();
      assistant.updatedAt = new Date();
    }
  },

  // Export/Import for persistence
  exportToJSON: async (): Promise<string> => {
    return JSON.stringify(assistants, null, 2);
  },

  importFromJSON: async (json: string): Promise<void> => {
    try {
      const imported = JSON.parse(json);
      if (Array.isArray(imported)) {
        assistants = imported;
      }
    } catch (error) {
      console.error('Failed to import assistants:', error);
      throw error;
    }
  },
};

// Helper to get voice details
export function getVoiceDetails(provider: string, voiceId: string): { name: string; description: string } | null {
  const voiceLibrary: Record<string, Record<string, { name: string; description: string }>> = {
    elevenlabs: {
      'KYiVPerWcenyBTIvWbfY': { name: 'Mahi', description: 'Warm and professional Indian accent' },
      '21m00Tcm4TlvDq8ikWAM': { name: 'Rachel', description: 'Professional female voice' },
      'pNInz6obpgDQGcFmaJgB': { name: 'Adam', description: 'Confident male voice' },
      'EXAVITQu4vr4xnSDxMaL': { name: 'Bella', description: 'Soft and gentle voice' },
      'MF3mGyEYCl7XYWbV9V6O': { name: 'Elli', description: 'Youthful and energetic' },
      'TxGEqnHWrfWFTfGW9XjX': { name: 'Josh', description: 'Deep and authoritative' },
      'VR6AewLTigWG4xSOukaG': { name: 'Arnold', description: 'Strong and commanding' },
      'pqHfZKP75CvOlQylNhV4': { name: 'Bill', description: 'Friendly and approachable' },
    },
  };

  return voiceLibrary[provider]?.[voiceId] || null;
}