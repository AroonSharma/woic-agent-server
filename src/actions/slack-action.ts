// Slack Action Implementation  
// Phase 1, Task 2.3: Slack messaging with webhook and API support

import { 
  BaseAction, 
  ActionCategory, 
  ActionContext, 
  ActionResult, 
  SlackActionParams,
  SlackActionSchema,
  FunctionSchema,
  ValidationResult 
} from '../types/actions';
import { SLACK_FUNCTION_SCHEMA } from '../openai-manager';

export interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  defaultChannel?: string;
  enableRichFormatting?: boolean;
  enableThreading?: boolean;
  maxMessageLength?: number;
}

export interface SlackBlock {
  type: string;
  text?: {
    type: 'plain_text' | 'mrkdwn';
    text: string;
  };
  elements?: any[];
  accessory?: any;
}

export interface SlackAttachment {
  color?: string;
  pretext?: string;
  author_name?: string;
  author_link?: string;
  author_icon?: string;
  title?: string;
  title_link?: string;
  text?: string;
  fields?: Array<{
    title: string;
    value: string;
    short?: boolean;
  }>;
  image_url?: string;
  thumb_url?: string;
  footer?: string;
  footer_icon?: string;
  ts?: number;
}

export class SlackAction implements BaseAction {
  name = 'send_slack_message';
  description = 'Send a message to a Slack channel or user';
  category = ActionCategory.COMMUNICATION;
  schema: FunctionSchema = SLACK_FUNCTION_SCHEMA;

  private config: SlackConfig;

  constructor(config?: Partial<SlackConfig>) {
    this.config = {
      webhookUrl: process.env.SLACK_WEBHOOK_URL,
      botToken: process.env.SLACK_BOT_TOKEN,
      defaultChannel: process.env.SLACK_DEFAULT_CHANNEL || '#general',
      enableRichFormatting: true,
      enableThreading: true,
      maxMessageLength: 4000,
      ...config
    };
  }

  async execute(params: SlackActionParams, context: ActionContext): Promise<ActionResult> {
    const startTime = Date.now();

    try {
      // Validate configuration
      if (!this.config.webhookUrl && !this.config.botToken) {
        throw new Error('Slack not properly configured. Please provide either webhook URL or bot token.');
      }

      // Process message content
      const processedMessage = this.processMessage(params.message);
      
      // Determine channel
      const channel = params.channel || this.config.defaultChannel || '#general';

      // Prepare message payload
      const messagePayload = this.buildMessagePayload(
        processedMessage,
        channel,
        params,
        context
      );

      // Send message
      console.log(`[slack-action] Sending message to ${channel}: ${processedMessage.substring(0, 50)}...`);
      
      const result = await this.sendMessage(messagePayload);

      const executionTime = Date.now() - startTime;
      console.log(`[slack-action] Message sent successfully in ${executionTime}ms`);

      return {
        success: true,
        message: `Message sent to ${channel} successfully`,
        data: {
          channel,
          messageLength: processedMessage.length,
          sentAt: new Date().toISOString(),
          messageId: result.ts || result.message?.ts,
          threadTs: params.threadTs,
          hasBlocks: !!(params.blocks && params.blocks.length > 0),
          hasAttachments: !!(params.attachments && params.attachments.length > 0)
        },
        executionTimeMs: executionTime
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown Slack error';
      
      console.error(`[slack-action] Message sending failed after ${executionTime}ms:`, errorMessage);

      return {
        success: false,
        message: `Failed to send Slack message: ${errorMessage}`,
        executionTimeMs: executionTime,
        metadata: {
          error: errorMessage,
          channel: params.channel,
          messageLength: params.message.length
        }
      };
    }
  }

  validate(params: any): ValidationResult {
    try {
      SlackActionSchema.parse(params);
      
      const errors: string[] = [];
      const warnings: string[] = [];

      // Additional validation
      if (params.message && params.message.length > (this.config.maxMessageLength || 4000)) {
        errors.push(`Message too long (max ${this.config.maxMessageLength || 4000} characters)`);
      }

      if (params.message && params.message.trim().length === 0) {
        errors.push('Message cannot be empty');
      }

      // Validate channel format
      if (params.channel) {
        if (!this.isValidChannel(params.channel)) {
          errors.push('Invalid channel format. Use #channel-name or @username');
        }
      }

      // Validate thread timestamp format
      if (params.threadTs && !this.isValidTimestamp(params.threadTs)) {
        errors.push('Invalid thread timestamp format');
      }

      // Check for potentially sensitive content
      if (this.containsSensitiveData(params.message)) {
        warnings.push('Message may contain sensitive information');
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
      };

    } catch (error) {
      return {
        valid: false,
        errors: ['Invalid Slack message parameters']
      };
    }
  }

  getRequiredPermissions(): string[] {
    return ['slack:write'];
  }

  private processMessage(message: string): string {
    // Clean and process message
    return message
      .trim()
      .substring(0, this.config.maxMessageLength || 4000);
  }

  private buildMessagePayload(
    message: string, 
    channel: string, 
    params: SlackActionParams,
    context: ActionContext
  ): any {
    const payload: any = {
      channel,
      text: message,
    };

    // Add thread timestamp if provided
    if (params.threadTs) {
      payload.thread_ts = params.threadTs;
    }

    // Add blocks if provided (for rich formatting)
    if (params.blocks && params.blocks.length > 0) {
      payload.blocks = params.blocks;
    }

    // Add attachments if provided
    if (params.attachments && params.attachments.length > 0) {
      payload.attachments = params.attachments;
    }

    // Add metadata for webhook
    if (this.config.webhookUrl) {
      payload.username = `Voice Agent (${context.userEmail || context.userId})`;
      payload.icon_emoji = ':robot_face:';
    }

    // Add rich formatting if enabled and no custom blocks provided
    if (this.config.enableRichFormatting && !params.blocks) {
      payload.blocks = this.createDefaultBlocks(message, context);
    }

    return payload;
  }

  private async sendMessage(payload: any): Promise<any> {
    if (this.config.webhookUrl) {
      return await this.sendViaWebhook(payload);
    } else if (this.config.botToken) {
      return await this.sendViaAPI(payload);
    } else {
      throw new Error('No Slack configuration available');
    }
  }

  private async sendViaWebhook(payload: any): Promise<any> {
    const response = await fetch(this.config.webhookUrl!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook request failed: ${response.status} ${errorText}`);
    }

    // Webhook doesn't return much data
    return { success: true, method: 'webhook' };
  }

  private async sendViaAPI(payload: any): Promise<any> {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json() as any;

    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error}`);
    }

    return result;
  }

  private createDefaultBlocks(message: string, context: ActionContext): SlackBlock[] {
    return [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message
        }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🤖 Sent by Voice Agent | User: ${context.userEmail || context.userId} | ${new Date().toLocaleString()}`
          }
        ]
      }
    ];
  }

  private isValidChannel(channel: string): boolean {
    // Check for valid channel formats: #channel-name, @username, or channel ID
    const channelRegex = /^[#@].+|^[CD][A-Z0-9]{8,}$/;
    return channelRegex.test(channel);
  }

  private isValidTimestamp(timestamp: string): boolean {
    // Slack timestamps are in format like "1234567890.123456"
    const timestampRegex = /^\d{10}\.\d{6}$/;
    return timestampRegex.test(timestamp);
  }

  private containsSensitiveData(message: string): boolean {
    const sensitivePatterns = [
      /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/,  // Credit card numbers
      /\b\d{3}[- ]?\d{2}[- ]?\d{4}\b/,  // SSN patterns
      /password|pwd|secret|key|token/i,  // Common sensitive keywords
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i  // Email addresses (might be intentional)
    ];

    return sensitivePatterns.some(pattern => pattern.test(message));
  }

  /**
   * Additional utility methods for Slack integration
   */

  async sendRichMessage(
    channel: string,
    title: string,
    message: string,
    color: string = 'good',
    context?: ActionContext
  ): Promise<ActionResult> {
    const attachment: SlackAttachment = {
      color,
      title,
      text: message,
      footer: 'Voice Agent',
      footer_icon: 'https://via.placeholder.com/16x16.png?text=🤖',
      ts: Math.floor(Date.now() / 1000)
    };

    const params: SlackActionParams = {
      channel,
      message: title,
      attachments: [attachment]
    };

    return this.execute(params, context || {
      userId: 'system',
      agentId: 'system',
      sessionId: 'system',
      permissions: ['slack:write'],
      timestamp: Date.now()
    });
  }

  async sendCodeBlock(
    channel: string,
    code: string,
    language: string = 'text',
    title?: string,
    context?: ActionContext
  ): Promise<ActionResult> {
    const formattedMessage = title 
      ? `${title}\n\`\`\`${language}\n${code}\n\`\`\``
      : `\`\`\`${language}\n${code}\n\`\`\``;

    const params: SlackActionParams = {
      channel,
      message: formattedMessage
    };

    return this.execute(params, context || {
      userId: 'system',
      agentId: 'system', 
      sessionId: 'system',
      permissions: ['slack:write'],
      timestamp: Date.now()
    });
  }

  async sendButtonMessage(
    channel: string,
    message: string,
    buttons: Array<{ text: string; value: string; style?: 'primary' | 'danger' }>,
    context?: ActionContext
  ): Promise<ActionResult> {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: message
        }
      },
      {
        type: 'actions',
        elements: buttons.map(button => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: button.text
          },
          value: button.value,
          style: button.style
        }))
      }
    ];

    const params: SlackActionParams = {
      channel,
      message,
      blocks
    };

    return this.execute(params, context || {
      userId: 'system',
      agentId: 'system',
      sessionId: 'system', 
      permissions: ['slack:write'],
      timestamp: Date.now()
    });
  }

  /**
   * Test Slack configuration
   */
  async testConfiguration(): Promise<boolean> {
    try {
      if (this.config.webhookUrl) {
        // Test webhook with a simple message
        const testPayload = {
          text: 'Test message from Voice Agent - Configuration OK ✅',
          username: 'Voice Agent Test',
          icon_emoji: ':white_check_mark:'
        };

        const response = await fetch(this.config.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(testPayload)
        });

        return response.ok;
      }

      if (this.config.botToken) {
        // Test API with auth.test
        const response = await fetch('https://slack.com/api/auth.test', {
          headers: { 'Authorization': `Bearer ${this.config.botToken}` }
        });

        const result = await response.json() as any;
        return result.ok;
      }

      return false;
    } catch (error) {
      console.error('[slack-action] Configuration test failed:', error);
      return false;
    }
  }

  /**
   * Get Slack integration statistics
   */
  getStats(): { configured: boolean; method: string; hasDefaultChannel: boolean } {
    return {
      configured: !!(this.config.webhookUrl || this.config.botToken),
      method: this.config.webhookUrl ? 'webhook' : (this.config.botToken ? 'api' : 'none'),
      hasDefaultChannel: !!this.config.defaultChannel
    };
  }
}