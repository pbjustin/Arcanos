import nodemailer from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export interface EmailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
  verified?: boolean;
  transportType?: string;
}

class EmailService {
  private transporter: nodemailer.Transporter;
  private defaultFromName: string;
  private senderEmail: string;
  private transportType: string;

  constructor() {
    const { transporter, transportType, senderEmail } = this.createTransport();
    
    this.transporter = transporter;
    this.transportType = transportType;
    this.senderEmail = senderEmail;
    this.defaultFromName = process.env.EMAIL_FROM_NAME || 'Arcanos Backend';

    console.log('📧 Email Service initialized with', transportType);
    console.log('📧 Configured sender:', senderEmail);
  }

  private createTransport(): { transporter: nodemailer.Transporter, transportType: string, senderEmail: string } {
    // Priority order: Ethereal (for testing) > Mailtrap (for testing) > Gmail (production)
    
    // Ethereal Email (for testing)
    if (process.env.EMAIL_SERVICE === 'ethereal' || process.env.ETHEREAL_USER) {
      if (process.env.ETHEREAL_USER && process.env.ETHEREAL_PASS) {
        const senderEmail = process.env.ETHEREAL_USER;
        return {
          transporter: nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
              user: process.env.ETHEREAL_USER,
              pass: process.env.ETHEREAL_PASS
            }
          }),
          transportType: 'Ethereal Email (Testing)',
          senderEmail
        };
      }
    }

    // Mailtrap (for testing)
    if (process.env.EMAIL_SERVICE === 'mailtrap' || process.env.MAILTRAP_USER) {
      if (process.env.MAILTRAP_USER && process.env.MAILTRAP_PASS) {
        const senderEmail = process.env.MAILTRAP_FROM || 'test@example.com';
        return {
          transporter: nodemailer.createTransport({
            host: 'smtp.mailtrap.io',
            port: 2525,
            secure: false,
            auth: {
              user: process.env.MAILTRAP_USER,
              pass: process.env.MAILTRAP_PASS
            }
          }),
          transportType: 'Mailtrap (Testing)',
          senderEmail
        };
      }
    }

    // Gmail SMTP (production/default)
    if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
      const senderEmail = process.env.GMAIL_USER;
      return {
        transporter: nodemailer.createTransport({
          service: 'gmail',
          auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD
          }
        }),
        transportType: 'Gmail SMTP',
        senderEmail
      };
    }

    throw new Error('No email service configured. Please set either GMAIL_USER/GMAIL_APP_PASSWORD, MAILTRAP_USER/MAILTRAP_PASS, or ETHEREAL_USER/ETHEREAL_PASS environment variables');
  }

  async sendEmail(to: string, subject: string, html: string, from?: string): Promise<EmailResponse> {
    console.log('📧 Starting email send process...');
    console.log('📧 Transport type:', this.transportType);
    console.log('📧 Sending email to:', to);
    console.log('📧 Subject:', subject);
    
    try {
      // REQUIREMENT: Call transporter.verify() before sending
      console.log('🔍 Verifying transporter connection before sending...');
      const verifyStartTime = Date.now();
      
      let verificationSuccess = false;
      try {
        await this.transporter.verify();
        verificationSuccess = true;
        const verifyEndTime = Date.now();
        console.log('✅ Transporter verification successful in', verifyEndTime - verifyStartTime, 'ms');
      } catch (verifyError: any) {
        const verifyEndTime = Date.now();
        console.error('❌ Transporter verification FAILED in', verifyEndTime - verifyStartTime, 'ms');
        console.error('🔍 Verification error details:', {
          name: verifyError.name,
          message: verifyError.message,
          code: verifyError.code,
          command: verifyError.command,
          response: verifyError.response,
          responseCode: verifyError.responseCode,
          stack: verifyError.stack
        });
        
        return {
          success: false,
          error: `Transporter verification failed: ${verifyError.message}`,
          verified: false,
          transportType: this.transportType
        };
      }

      const fromAddress = from || `"${this.defaultFromName}" <${this.senderEmail}>`;
      
      const mailOptions = {
        from: fromAddress,
        to: to,
        subject: subject,
        html: html
      };

      console.log('📧 Mail options prepared:', {
        from: fromAddress,
        to: to,
        subject: subject,
        contentLength: html.length
      });

      const sendStartTime = Date.now();
      console.log('⏰ Sending email at:', new Date().toISOString());
      
      // Add timeout handling to detect silent failures
      const EMAIL_TIMEOUT = 30000; // 30 seconds timeout
      
      const sendEmailPromise = this.transporter.sendMail(mailOptions);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Email sending timed out after ${EMAIL_TIMEOUT}ms - possible silent failure`));
        }, EMAIL_TIMEOUT);
      });

      const info = await Promise.race([sendEmailPromise, timeoutPromise]) as any;
      
      const sendEndTime = Date.now();
      const sendDuration = sendEndTime - sendStartTime;
      
      console.log('✅ Email sent successfully in:', sendDuration, 'ms');
      console.log('📧 Message ID:', info.messageId);
      console.log('📧 Send response details:', {
        messageId: info.messageId,
        response: info.response,
        envelope: info.envelope,
        accepted: info.accepted,
        rejected: info.rejected,
        pending: info.pending
      });

      // REQUIREMENT: Add fallback warning if transporter silently fails
      if (!info.messageId) {
        console.warn('⚠️ FALLBACK WARNING: Email may have silently failed - no message ID returned');
        return {
          success: false,
          error: 'Silent failure detected: No message ID returned from transporter',
          verified: verificationSuccess,
          transportType: this.transportType
        };
      }

      // Check for rejected emails
      if (info.rejected && info.rejected.length > 0) {
        console.warn('⚠️ FALLBACK WARNING: Some recipients were rejected:', info.rejected);
        return {
          success: false,
          error: `Email rejected for recipients: ${info.rejected.join(', ')}`,
          verified: verificationSuccess,
          transportType: this.transportType
        };
      }

      return {
        success: true,
        messageId: info.messageId,
        verified: verificationSuccess,
        transportType: this.transportType
      };
      
    } catch (error: any) {
      const errorEndTime = Date.now();
      console.error('❌ Email sending failed');
      
      // REQUIREMENT: Print full error messages to console
      console.error('🔍 FULL ERROR DETAILS:', {
        name: error.name,
        message: error.message,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
        errno: error.errno,
        syscall: error.syscall,
        hostname: error.hostname,
        stack: error.stack,
        timestamp: new Date().toISOString(),
        transportType: this.transportType
      });
      
      // Additional context logging
      console.error('🔍 Email context:', {
        to: to,
        subject: subject,
        fromAddress: from || `"${this.defaultFromName}" <${this.senderEmail}>`,
        transportType: this.transportType,
        senderEmail: this.senderEmail
      });
      
      return {
        success: false,
        error: error.message,
        verified: false,
        transportType: this.transportType
      };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      console.log('🔍 Verifying email connection...');
      const startTime = Date.now();
      
      await this.transporter.verify();
      
      const endTime = Date.now();
      console.log('✅ Email service connection verified in', endTime - startTime, 'ms');
      console.log('📧 Transport type:', this.transportType);
      console.log('📧 Sender email:', this.senderEmail);
      
      return true;
    } catch (error: any) {
      const endTime = Date.now();
      console.error('❌ Email service connection failed');
      console.error('🔍 Connection verification error details:', {
        name: error.name,
        message: error.message,
        code: error.code,
        command: error.command,
        response: error.response,
        responseCode: error.responseCode,
        stack: error.stack,
        transportType: this.transportType,
        timestamp: new Date().toISOString()
      });
      
      return false;
    }
  }

  getConfiguredSender(): string {
    return this.senderEmail;
  }

  getTransportType(): string {
    return this.transportType;
  }
}

// Create singleton instance
let emailService: EmailService | null = null;

// Lazy initialize email service
function getEmailService(): EmailService {
  if (!emailService) {
    emailService = new EmailService();
  }
  return emailService;
}

// Export the main function for global access
export async function sendEmail(to: string, subject: string, html: string, from?: string): Promise<EmailResponse> {
  try {
    const service = getEmailService();
    return await service.sendEmail(to, subject, html, from);
  } catch (error: any) {
    console.error('❌ Failed to initialize email service:');
    console.error('🔍 Initialization error details:', {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    
    return {
      success: false,
      error: `Email service initialization failed: ${error.message}`,
      verified: false,
      transportType: 'Unknown'
    };
  }
}

// Export additional utility functions
export async function verifyEmailConnection(): Promise<boolean> {
  try {
    const service = getEmailService();
    return await service.verifyConnection();
  } catch (error: any) {
    console.error('❌ Email connection verification failed during service access:');
    console.error('🔍 Service access error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return false;
  }
}

export function getEmailSender(): string {
  try {
    const service = getEmailService();
    return service.getConfiguredSender();
  } catch (error: any) {
    console.error('❌ Failed to get email sender:');
    console.error('🔍 Sender access error:', {
      name: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString()
    });
    return 'Not configured';
  }
}

export function getEmailTransportType(): string {
  try {
    const service = getEmailService();
    return service.getTransportType();
  } catch (error: any) {
    console.error('❌ Failed to get transport type:', error.message);
    return 'Unknown';
  }
}

// Export the service class for advanced usage
export default EmailService;