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
}

class EmailService {
  private transporter: nodemailer.Transporter;
  private defaultFromName: string;
  private gmailUser: string;

  constructor() {
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD environment variables are required');
    }

    this.gmailUser = process.env.GMAIL_USER;
    this.defaultFromName = process.env.EMAIL_FROM_NAME || 'Arcanos Backend';

    // Create transporter with Gmail SMTP configuration
    this.transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: this.gmailUser,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });

    console.log('📧 Email Service initialized with Gmail SMTP');
    console.log('📧 Configured sender:', this.gmailUser);
  }

  async sendEmail(to: string, subject: string, html: string, from?: string): Promise<EmailResponse> {
    console.log('📧 Sending email to:', to);
    console.log('📧 Subject:', subject);
    
    try {
      const fromAddress = from || `"${this.defaultFromName}" <${this.gmailUser}>`;
      
      const mailOptions = {
        from: fromAddress,
        to: to,
        subject: subject,
        html: html
      };

      const startTime = Date.now();
      console.log('⏰ Sending email at:', new Date().toISOString());
      
      const info = await this.transporter.sendMail(mailOptions);
      
      const endTime = Date.now();
      console.log('✅ Email sent successfully in:', endTime - startTime, 'ms');
      console.log('📧 Message ID:', info.messageId);

      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error: any) {
      console.error('❌ Email sending failed:', error.message);
      console.error('🔍 Error details:', {
        name: error.name,
        code: error.code,
        response: error.response
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      console.log('✅ Email service connection verified');
      return true;
    } catch (error: any) {
      console.error('❌ Email service connection failed:', error.message);
      return false;
    }
  }

  getConfiguredSender(): string {
    return this.gmailUser;
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
    console.error('❌ Failed to initialize email service:', error.message);
    return {
      success: false,
      error: `Email service initialization failed: ${error.message}`
    };
  }
}

// Export additional utility functions
export async function verifyEmailConnection(): Promise<boolean> {
  try {
    const service = getEmailService();
    return await service.verifyConnection();
  } catch (error: any) {
    console.error('❌ Email connection verification failed:', error.message);
    return false;
  }
}

export function getEmailSender(): string {
  try {
    const service = getEmailService();
    return service.getConfiguredSender();
  } catch (error: any) {
    console.error('❌ Failed to get email sender:', error.message);
    return 'Not configured';
  }
}

// Export the service class for advanced usage
export default EmailService;