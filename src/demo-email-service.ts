// Email service demonstration script
// This script shows how to use the email service without actually sending emails

import { sendEmail, verifyEmailConnection, getEmailSender } from './services/email';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function demonstrateEmailService() {
  console.log('📧 Arcanos Email Service Demonstration\n');

  console.log('📋 Environment Variables Required:');
  console.log('   GMAIL_USER: Gmail address to send emails from');
  console.log('   GMAIL_APP_PASSWORD: 16-character app password (not regular password)');
  console.log('   EMAIL_FROM_NAME: Display name for emails (optional)');
  console.log('   TEST_EMAIL_RECEIVER: Email to send test messages to (optional)\n');

  // Check configuration
  const hasGmailUser = !!process.env.GMAIL_USER;
  const hasGmailPassword = !!process.env.GMAIL_APP_PASSWORD;
  const hasFromName = !!process.env.EMAIL_FROM_NAME;
  
  console.log('📊 Configuration Status:');
  console.log('   GMAIL_USER:', hasGmailUser ? '✅ Set' : '❌ Not set');
  console.log('   GMAIL_APP_PASSWORD:', hasGmailPassword ? '✅ Set' : '❌ Not set');
  console.log('   EMAIL_FROM_NAME:', hasFromName ? '✅ Set' : '⚠️ Not set (will use default)');

  if (!hasGmailUser || !hasGmailPassword) {
    console.log('\n❌ Email service is not properly configured.');
    console.log('   Please set GMAIL_USER and GMAIL_APP_PASSWORD in your .env file.');
    console.log('   To get an app password: https://support.google.com/accounts/answer/185833');
    return;
  }

  console.log('\n🔧 Email Service Functions Available:');
  console.log('   sendEmail(to, subject, html, from?)');
  console.log('   verifyEmailConnection()');
  console.log('   getEmailSender()');

  console.log('\n📧 Configured sender:', getEmailSender());

  // Test connection (will fail with dummy credentials but shows the process)
  console.log('\n🔍 Testing email connection...');
  try {
    const connectionValid = await verifyEmailConnection();
    console.log('   Connection status:', connectionValid ? '✅ Valid' : '❌ Failed');
  } catch (error: any) {
    console.log('   Connection test failed:', error.message);
  }

  console.log('\n💡 Example Usage:');
  console.log(`
    import { sendEmail } from './services/email';

    // Send an email
    const result = await sendEmail(
      'recipient@example.com',
      'Hello from Arcanos!',
      '<h1>Welcome!</h1><p>This is an HTML email.</p>'
    );

    if (result.success) {
      console.log('Email sent! Message ID:', result.messageId);
    } else {
      console.log('Email failed:', result.error);
    }
  `);

  console.log('\n🌐 API Endpoints:');
  console.log('   GET  /api/email/status  - Check email service status');
  console.log('   POST /api/email/send    - Send an email');
  console.log('        Body: { "to": "email@domain.com", "subject": "Subject", "html": "<p>Content</p>" }');

  console.log('\n🏁 Email service demonstration completed.');
}

// Export for testing
export { demonstrateEmailService };

// Run demonstration if called directly
if (require.main === module) {
  demonstrateEmailService().catch(error => {
    console.error('💥 Demonstration failed:', error);
    process.exit(1);
  });
}