// Email Action Implementation
// Phase 1, Task 2.1: Email sending functionality with SMTP support

import nodemailer from 'nodemailer';
import { 
  BaseAction, 
  ActionCategory, 
  ActionContext, 
  ActionResult, 
  EmailActionParams,
  EmailActionSchema,
  FunctionSchema,
  ValidationResult 
} from '../types/actions';
import { EMAIL_FUNCTION_SCHEMA } from '../openai-manager';

export interface EmailConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword: string;
  defaultFromEmail: string;
  defaultFromName: string;
}

export interface EmailTemplate {
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  variables: string[];
}

export class EmailAction implements BaseAction {
  name = 'send_email';
  description = 'Send an email to one or more recipients';
  category = ActionCategory.COMMUNICATION;
  schema: FunctionSchema = EMAIL_FUNCTION_SCHEMA;

  private config: EmailConfig;
  private transporter: nodemailer.Transporter | null = null;
  private templates: Map<string, EmailTemplate> = new Map();

  constructor(config?: Partial<EmailConfig>) {
    this.config = {
      smtpHost: process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: parseInt(process.env.SMTP_PORT || '587'),
      smtpSecure: process.env.SMTP_SECURE === 'true',
      smtpUser: process.env.SMTP_USER || '',
      smtpPassword: process.env.SMTP_PASSWORD || '',
      defaultFromEmail: process.env.DEFAULT_FROM_EMAIL || '',
      defaultFromName: process.env.DEFAULT_FROM_NAME || 'Voice Agent',
      ...config
    };

    this.initializeTransporter();
    this.loadDefaultTemplates();
  }

  private initializeTransporter(): void {
    if (!this.config.smtpUser || !this.config.smtpPassword) {
      console.warn('[email-action] SMTP credentials not configured. Email sending will fail.');
      return;
    }

    try {
      this.transporter = nodemailer.createTransport({
        host: this.config.smtpHost,
        port: this.config.smtpPort,
        secure: this.config.smtpSecure,
        requireTLS: process.env.SMTP_TLS === 'true',
        auth: {
          user: this.config.smtpUser,
          pass: this.config.smtpPassword,
        },
        pool: true, // Use connection pooling
        maxConnections: 5,
        maxMessages: 100,
        tls: {
          rejectUnauthorized: false // Allow self-signed certificates
        }
      });

      // Verify connection
      this.transporter?.verify()
        .then(() => console.log('[email-action] SMTP connection verified successfully'))
        .catch(error => console.error('[email-action] SMTP connection verification failed:', error.message));

    } catch (error) {
      console.error('[email-action] Failed to initialize SMTP transporter:', error);
    }
  }

  private loadDefaultTemplates(): void {
    const defaultTemplates: EmailTemplate[] = [
      {
        name: 'basic',
        subject: '{subject}',
        htmlBody: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
              <h2 style="color: #333; margin-top: 0;">Message from Voice Agent</h2>
              <div style="background-color: white; padding: 20px; border-radius: 4px; margin-top: 16px;">
                <p style="color: #555; line-height: 1.6; margin: 0;">{body}</p>
              </div>
              <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid #e9ecef; text-align: center; color: #6c757d; font-size: 12px;">
                This email was sent by your voice agent assistant
              </div>
            </div>
          </div>
        `,
        textBody: '{body}\n\n---\nThis email was sent by your voice agent assistant',
        variables: ['subject', 'body']
      },
      {
        name: 'meeting_request',
        subject: 'Meeting Request: {title}',
        htmlBody: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px;">
              <h2 style="color: #333; margin-top: 0;">📅 Meeting Request</h2>
              <div style="background-color: white; padding: 20px; border-radius: 4px; margin-top: 16px;">
                <h3 style="color: #495057; margin-top: 0;">{title}</h3>
                <p style="color: #555; line-height: 1.6;"><strong>Date & Time:</strong> {datetime}</p>
                <p style="color: #555; line-height: 1.6;"><strong>Duration:</strong> {duration}</p>
                {agenda ? '<p style="color: #555; line-height: 1.6;"><strong>Agenda:</strong> {agenda}</p>' : ''}
                <p style="color: #555; line-height: 1.6;">{body}</p>
              </div>
            </div>
          </div>
        `,
        textBody: '📅 Meeting Request: {title}\n\nDate & Time: {datetime}\nDuration: {duration}\n{agenda}\n{body}',
        variables: ['title', 'datetime', 'duration', 'agenda', 'body']
      }
    ];

    defaultTemplates.forEach(template => {
      this.templates.set(template.name, template);
    });
  }

  async execute(params: EmailActionParams, context: ActionContext): Promise<ActionResult> {
    const startTime = Date.now();

    try {
      // Validate transporter is available
      if (!this.transporter) {
        throw new Error('Email service not properly configured. Please check SMTP settings.');
      }

      // Validate email addresses
      this.validateEmailAddresses([...params.to, ...(params.cc || []), ...(params.bcc || [])]);

      // Determine from address
      const fromEmail = this.config.defaultFromEmail || this.config.smtpUser;
      if (!fromEmail) {
        throw new Error('No default from email configured');
      }

      // Apply template if needed
      const { subject, htmlBody, textBody } = this.processTemplate(params);

      // Prepare email options
      const mailOptions: nodemailer.SendMailOptions = {
        from: `${this.config.defaultFromName} <${fromEmail}>`,
        to: params.to.join(', '),
        subject,
        html: htmlBody,
        text: textBody,
        priority: this.mapPriority(params.priority || 'normal')
      };

      // Add CC/BCC if provided
      if (params.cc && params.cc.length > 0) {
        mailOptions.cc = params.cc.join(', ');
      }
      if (params.bcc && params.bcc.length > 0) {
        mailOptions.bcc = params.bcc.join(', ');
      }

      // Handle attachments (if provided as URLs or file paths)
      if (params.attachments && params.attachments.length > 0) {
        mailOptions.attachments = await this.processAttachments(params.attachments);
      }

      // Send email
      console.log(`[email-action] Sending email to ${params.to.length} recipient(s): ${params.subject.substring(0, 50)}...`);
      const info = await this.transporter.sendMail(mailOptions);

      const executionTime = Date.now() - startTime;
      console.log(`[email-action] Email sent successfully in ${executionTime}ms. Message ID: ${info.messageId}`);

      return {
        success: true,
        message: `Email sent successfully to ${params.to.length} recipient(s)`,
        data: {
          messageId: info.messageId,
          recipients: params.to,
          subject: params.subject,
          sentAt: new Date().toISOString(),
          executionTimeMs: executionTime
        },
        executionTimeMs: executionTime
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown email error';
      
      console.error(`[email-action] Email sending failed after ${executionTime}ms:`, errorMessage);

      return {
        success: false,
        message: `Failed to send email: ${errorMessage}`,
        executionTimeMs: executionTime,
        metadata: {
          error: errorMessage,
          recipients: params.to,
          subject: params.subject
        }
      };
    }
  }

  validate(params: any): ValidationResult {
    try {
      EmailActionSchema.parse(params);
      
      // Additional validation
      const errors: string[] = [];
      
      // Check email format
      const allEmails = [...(params.to || []), ...(params.cc || []), ...(params.bcc || [])];
      allEmails.forEach(email => {
        if (!this.isValidEmail(email)) {
          errors.push(`Invalid email format: ${email}`);
        }
      });

      // Check subject length
      if (params.subject && params.subject.length > 200) {
        errors.push('Subject line too long (max 200 characters)');
      }

      // Check body length
      if (params.body && params.body.length > 50000) {
        errors.push('Email body too long (max 50,000 characters)');
      }

      return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined
      };

    } catch (error) {
      return {
        valid: false,
        errors: ['Invalid email parameters']
      };
    }
  }

  getRequiredPermissions(): string[] {
    return ['email:send'];
  }

  private validateEmailAddresses(emails: string[]): void {
    const invalid = emails.filter(email => !this.isValidEmail(email));
    if (invalid.length > 0) {
      throw new Error(`Invalid email addresses: ${invalid.join(', ')}`);
    }
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private processTemplate(params: EmailActionParams): { subject: string; htmlBody: string; textBody: string } {
    // For now, use basic template. In the future, detect template from subject/body patterns
    const template = this.templates.get('basic')!;
    
    const variables = {
      subject: params.subject,
      body: params.body
    };

    return {
      subject: this.replaceTemplateVariables(template.subject, variables),
      htmlBody: this.replaceTemplateVariables(template.htmlBody, variables),
      textBody: this.replaceTemplateVariables(template.textBody, variables)
    };
  }

  private replaceTemplateVariables(template: string, variables: Record<string, string>): string {
    let result = template;
    Object.entries(variables).forEach(([key, value]) => {
      const regex = new RegExp(`{${key}}`, 'g');
      result = result.replace(regex, value);
    });
    return result;
  }

  private mapPriority(priority: 'low' | 'normal' | 'high'): 'low' | 'normal' | 'high' {
    return priority;
  }

  private async processAttachments(attachments: string[]): Promise<any[]> {
    // For now, assume attachments are file paths or URLs
    // In production, you might want to validate and process these more thoroughly
    return attachments.map((attachment, index) => ({
      filename: `attachment_${index + 1}`,
      path: attachment
    }));
  }

  /**
   * Add a custom email template
   */
  addTemplate(template: EmailTemplate): void {
    this.templates.set(template.name, template);
    console.log(`[email-action] Added email template: ${template.name}`);
  }

  /**
   * Test email configuration
   */
  async testConfiguration(): Promise<boolean> {
    try {
      if (!this.transporter) {
        return false;
      }
      
      await this.transporter.verify();
      return true;
    } catch (error) {
      console.error('[email-action] Configuration test failed:', error);
      return false;
    }
  }

  /**
   * Get email sending statistics
   */
  getStats(): { configured: boolean; templatesCount: number; smtpHost: string } {
    return {
      configured: !!this.transporter,
      templatesCount: this.templates.size,
      smtpHost: this.config.smtpHost
    };
  }
}