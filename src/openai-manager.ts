// OpenAI Manager with Function Calling Support
// Phase 1, Task 1.2: Enhanced OpenAI integration with function calling

import OpenAI from 'openai';
import { 
  FunctionCall, 
  FunctionSchema, 
  ActionContext, 
  ActionResult,
  ActionType 
} from './types/actions';

export interface OpenAIManagerConfig {
  apiKey: string;
  defaultModel?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  functions?: FunctionSchema[];
  functionCall?: 'none' | 'auto' | { name: string };
  abortSignal?: AbortSignal;
}

export interface OpenAIResponse {
  text?: string;
  functionCall?: FunctionCall;
  finishReason: 'stop' | 'function_call' | 'length' | 'content_filter';
}

export class OpenAIManager {
  private client: OpenAI;
  private config: OpenAIManagerConfig;
  private availableFunctions: Map<string, FunctionSchema>;

  constructor(config: OpenAIManagerConfig) {
    this.config = {
      defaultModel: 'gpt-4o',
      temperature: 0.1,
      maxTokens: 500,
      ...config
    };
    
    this.client = new OpenAI({ 
      apiKey: this.config.apiKey 
    });
    
    this.availableFunctions = new Map();
  }

  /**
   * Register available functions for the agent
   */
  registerFunction(schema: FunctionSchema): void {
    this.availableFunctions.set(schema.name, schema);
  }

  /**
   * Register multiple functions at once
   */
  registerFunctions(schemas: FunctionSchema[]): void {
    schemas.forEach(schema => this.registerFunction(schema));
  }

  /**
   * Get available functions for a specific agent
   */
  getAvailableFunctions(agentId?: string): FunctionSchema[] {
    // TODO: In the future, filter functions based on agent permissions/config
    return Array.from(this.availableFunctions.values());
  }

  /**
   * Create chat completion with optional function calling
   */
  async createChatCompletion(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    options: ChatCompletionOptions = {}
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | OpenAI.Chat.Completions.ChatCompletion> {
    const {
      model = this.config.defaultModel,
      temperature = this.config.temperature,
      maxTokens = this.config.maxTokens,
      stream = false,
      functions,
      functionCall = 'auto',
      abortSignal
    } = options;

    const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: model!,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream
    };

    // Add function calling parameters if functions are provided
    if (functions && functions.length > 0) {
      requestOptions.functions = functions;
      requestOptions.function_call = functionCall;
    }

    // Add abort signal if provided
    const apiOptions = abortSignal ? { signal: abortSignal } : {};

    if (stream) {
      return this.client.chat.completions.create(requestOptions, apiOptions);
    } else {
      return this.client.chat.completions.create(
        { ...requestOptions, stream: false },
        apiOptions
      ) as Promise<OpenAI.Chat.Completions.ChatCompletion>;
    }
  }

  /**
   * Process streaming response with function call detection
   */
  async processStreamingResponse(
    stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
    onToken?: (token: string) => void,
    onFunctionCall?: (functionCall: FunctionCall) => void,
    onComplete?: (response: OpenAIResponse) => void
  ): Promise<OpenAIResponse> {
    let fullText = '';
    let functionCall: FunctionCall | undefined;
    let finishReason: OpenAIResponse['finishReason'] = 'stop';

    try {
      for await (const chunk of stream) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        // Handle regular text content
        const content = choice.delta?.content;
        if (content) {
          fullText += content;
          onToken?.(content);
        }

        // Handle function calls
        const deltaFunctionCall = choice.delta?.function_call;
        if (deltaFunctionCall) {
          if (!functionCall) {
            functionCall = {
              name: deltaFunctionCall.name || '',
              arguments: deltaFunctionCall.arguments || ''
            };
          } else {
            if (deltaFunctionCall.name) {
              functionCall.name += deltaFunctionCall.name;
            }
            if (deltaFunctionCall.arguments) {
              functionCall.arguments += deltaFunctionCall.arguments;
            }
          }
        }

        // Handle finish reason
        if (choice.finish_reason) {
          finishReason = choice.finish_reason as OpenAIResponse['finishReason'];
        }
      }

      // If we have a complete function call, notify the handler
      if (functionCall && functionCall.name && onFunctionCall) {
        onFunctionCall(functionCall);
      }

      const response: OpenAIResponse = {
        text: fullText || undefined,
        functionCall,
        finishReason
      };

      onComplete?.(response);
      return response;

    } catch (error) {
      console.error('[openai-manager] Error processing streaming response:', error);
      throw error;
    }
  }

  /**
   * Process non-streaming response with function call detection
   */
  async processResponse(
    completion: OpenAI.Chat.Completions.ChatCompletion
  ): Promise<OpenAIResponse> {
    const choice = completion.choices?.[0];
    if (!choice) {
      throw new Error('No choices in OpenAI response');
    }

    const response: OpenAIResponse = {
      finishReason: choice.finish_reason as OpenAIResponse['finishReason']
    };

    // Handle regular text content
    if (choice.message.content) {
      response.text = choice.message.content;
    }

    // Handle function calls
    if (choice.message.function_call) {
      response.functionCall = {
        name: choice.message.function_call.name,
        arguments: choice.message.function_call.arguments
      };
    }

    return response;
  }

  /**
   * Validate function call arguments
   */
  validateFunctionCall(functionCall: FunctionCall): { valid: boolean; errors?: string[] } {
    const schema = this.availableFunctions.get(functionCall.name);
    if (!schema) {
      return { valid: false, errors: [`Unknown function: ${functionCall.name}`] };
    }

    try {
      const args = JSON.parse(functionCall.arguments);
      
      // Basic validation - in production, you might want to use a more robust schema validator
      const requiredParams = schema.parameters.required || [];
      const errors: string[] = [];

      for (const param of requiredParams) {
        if (!(param in args)) {
          errors.push(`Missing required parameter: ${param}`);
        }
      }

      return { valid: errors.length === 0, errors: errors.length > 0 ? errors : undefined };

    } catch (error) {
      return { valid: false, errors: ['Invalid JSON in function arguments'] };
    }
  }

  /**
   * Get function schema by name
   */
  getFunctionSchema(functionName: string): FunctionSchema | undefined {
    return this.availableFunctions.get(functionName);
  }

  /**
   * Check if a function is available
   */
  hasFunctionAvailable(functionName: string): boolean {
    return this.availableFunctions.has(functionName);
  }

  /**
   * Create a conversation message for function call result
   */
  createFunctionResultMessage(
    functionCall: FunctionCall,
    result: ActionResult
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam {
    return {
      role: 'function',
      name: functionCall.name,
      content: JSON.stringify({
        success: result.success,
        message: result.message,
        data: result.data
      })
    };
  }

  /**
   * Continue conversation after function call
   */
  async continueConversationAfterFunction(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    functionCall: FunctionCall,
    functionResult: ActionResult,
    options: ChatCompletionOptions = {}
  ): Promise<AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk> | OpenAI.Chat.Completions.ChatCompletion> {
    // Add the function result to the conversation
    const updatedMessages = [
      ...messages,
      {
        role: 'assistant' as const,
        content: null,
        function_call: {
          name: functionCall.name,
          arguments: functionCall.arguments
        }
      },
      this.createFunctionResultMessage(functionCall, functionResult)
    ];

    // Continue the conversation without functions (to get a natural response)
    return this.createChatCompletion(updatedMessages, {
      ...options,
      functions: undefined, // Don't allow nested function calls for now
      functionCall: 'none'
    });
  }
}

// Export function schemas for common actions
export const EMAIL_FUNCTION_SCHEMA: FunctionSchema = {
  name: ActionType.SEND_EMAIL,
  description: 'Send an email message to recipients. Use when user asks to send emails, email someone, compose messages, or contact people via email. Examples: "send an email to john@example.com", "email the team about the meeting", "compose an email"',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'array',
        description: 'Email addresses of recipients',
        items: { type: 'string', format: 'email' }
      },
      subject: {
        type: 'string',
        description: 'Email subject line',
        maxLength: 200
      },
      body: {
        type: 'string',
        description: 'Email body content',
        maxLength: 10000
      },
      cc: {
        type: 'array',
        description: 'CC email addresses (optional)',
        items: { type: 'string', format: 'email' }
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Email priority level'
      }
    },
    required: ['to', 'subject', 'body']
  }
};

export const MEETING_FUNCTION_SCHEMA: FunctionSchema = {
  name: ActionType.BOOK_MEETING,
  description: 'Book a meeting or appointment',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Meeting title or subject',
        maxLength: 100
      },
      startDateTime: {
        type: 'string',
        format: 'date-time',
        description: 'Meeting start date and time in ISO format'
      },
      durationMinutes: {
        type: 'number',
        minimum: 15,
        maximum: 480,
        description: 'Meeting duration in minutes'
      },
      attendees: {
        type: 'array',
        description: 'Attendee email addresses',
        items: { type: 'string', format: 'email' }
      },
      location: {
        type: 'string',
        description: 'Meeting location or video conference link'
      },
      agenda: {
        type: 'string',
        description: 'Meeting agenda or description',
        maxLength: 1000
      }
    },
    required: ['title', 'startDateTime', 'durationMinutes']
  }
};

export const NOTES_FUNCTION_SCHEMA: FunctionSchema = {
  name: ActionType.CREATE_NOTE,
  description: 'Create and save a note, reminder, or memo. Use when user wants to remember something, take notes, jot down ideas, or create reminders. Examples: "take a note about this", "remember this for later", "create a note", "jot this down", "save this information"',
  parameters: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Note title',
        maxLength: 200
      },
      content: {
        type: 'string',
        description: 'Note content',
        maxLength: 50000
      },
      tags: {
        type: 'array',
        description: 'Note tags for organization',
        items: { type: 'string' }
      },
      priority: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'Note priority level'
      }
    },
    required: ['title', 'content']
  }
};

export const SLACK_FUNCTION_SCHEMA: FunctionSchema = {
  name: ActionType.SEND_SLACK,
  description: 'Send a message to Slack channels or users. Use when user wants to message team, post to Slack, notify colleagues, or communicate via Slack. Examples: "send a Slack message", "post to #general", "message the team", "notify everyone on Slack", "tell the team via Slack"',
  parameters: {
    type: 'object',
    properties: {
      channel: {
        type: 'string',
        description: 'Slack channel name or user ID'
      },
      message: {
        type: 'string',
        description: 'Message content to send',
        maxLength: 4000
      },
      threadTs: {
        type: 'string',
        description: 'Thread timestamp for threaded messages (optional)'
      }
    },
    required: ['channel', 'message']
  }
};

// Default function schemas that can be enabled for all agents
export const DEFAULT_FUNCTION_SCHEMAS = [
  EMAIL_FUNCTION_SCHEMA,
  MEETING_FUNCTION_SCHEMA,
  NOTES_FUNCTION_SCHEMA,
  SLACK_FUNCTION_SCHEMA
];