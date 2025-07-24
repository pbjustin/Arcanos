// Test script for email service functionality
// Run with: node dist/test-email-service.js

import { sendEmail, verifyEmailConnection, getEmailSender } from './services/email';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function testEmailService() {
  console.log('🧪 Testing Email Service...\n');

  // Test 1: Check configuration
  console.log('📧 Configured email sender:', getEmailSender());

  // Test 2: Verify connection
  console.log('\n🔍 Testing email connection...');
  const connectionValid = await verifyEmailConnection();
  console.log('Connection status:', connectionValid ? '✅ Valid' : '❌ Failed');

  if (!connectionValid) {
    console.log('❌ Email service not properly configured. Please check your environment variables.');
    return;
  }

  // Test 3: Send test email (only if proper email is configured)
  const testEmailReceiver = process.env.TEST_EMAIL_RECEIVER;
  if (testEmailReceiver) {
    console.log('\n📧 Sending test email...');
    
    const testHtml = `
      <h1>🎉 Email Service Test</h1>
      <p>Hello from the Arcanos backend!</p>
      <p>This is a test email to verify that the nodemailer integration is working correctly.</p>
      <hr>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>Sender:</strong> ${getEmailSender()}</p>
      <p><em>This email was sent automatically by the Arcanos email service test.</em></p>
    `;

    const result = await sendEmail(
      testEmailReceiver,
      '🧪 Arcanos Email Service Test',
      testHtml
    );

    if (result.success) {
      console.log('✅ Test email sent successfully!');
      console.log('📧 Message ID:', result.messageId);
    } else {
      console.log('❌ Test email failed:', result.error);
    }
  } else {
    console.log('\n⚠️ No TEST_EMAIL_RECEIVER configured, skipping test email send.');
    console.log('   Add TEST_EMAIL_RECEIVER=your-email@domain.com to .env to test sending.');
  }

  console.log('\n🏁 Email service test completed.');
}

// Run the test
testEmailService().catch(error => {
  console.error('💥 Test failed with error:', error);
  process.exit(1);
});