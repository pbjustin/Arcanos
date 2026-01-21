# Email Service Documentation

## Overview
The Arcanos backend includes an enhanced nodemailer-based email service with comprehensive error handling, pre-send verification, and support for multiple email services including Gmail (production), Mailtrap (testing), and Ethereal Email (testing).

## Key Features
- ✅ **Pre-send verification**: `transporter.verify()` called before each email send
- ✅ **Comprehensive error handling**: Full try/catch blocks with detailed error logging
- ✅ **Multiple service support**: Gmail, Mailtrap, and Ethereal Email
- ✅ **Timeout detection**: Prevents silent failures with 30-second timeout
- ✅ **Fallback warnings**: Detects and warns about silent failures
- ✅ **Enhanced logging**: Full error details printed to console for debugging

## Configuration

### Environment Variables
Add the appropriate environment variables to your `.env` file based on your email service:

```bash
# Choose email service: smtp (production), gmail (legacy), mailtrap (testing), ethereal (testing)
EMAIL_SERVICE=smtp

# Generic SMTP (recommended for Railway production)
# Works with SendGrid, Mailgun, Postmark, and other SMTP providers
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-smtp-password-or-api-key
EMAIL_FROM_NAME=Arcanos Backend

# Gmail SMTP (legacy - not recommended for Railway)
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-character-app-password

# Mailtrap (for testing - https://mailtrap.io)
# MAILTRAP_USER=your-mailtrap-username
# MAILTRAP_PASS=your-mailtrap-password
# MAILTRAP_FROM=test@example.com

# Ethereal Email (for testing - https://ethereal.email)
# ETHEREAL_USER=your-ethereal-username
# ETHEREAL_PASS=your-ethereal-password
```

### Service Priority
The email service automatically selects the appropriate transport in this order:
1. **Generic SMTP** - If `EMAIL_SERVICE=smtp` or `SMTP_HOST` is set (recommended for production)
2. **Ethereal Email** - If `EMAIL_SERVICE=ethereal` or `ETHEREAL_USER` is set
3. **Mailtrap** - If `EMAIL_SERVICE=mailtrap` or `MAILTRAP_USER` is set  
4. **Gmail SMTP** - If `GMAIL_USER` and `GMAIL_APP_PASSWORD` are set (legacy support)
5. **Error** - If no valid configuration is found

### Railway Production Recommendations

For Railway deployment, use the generic SMTP configuration with a reliable email service provider:

#### Recommended Email APIs (instead of SMTP)
For maximum reliability on Railway, consider using email APIs instead of SMTP:
- **SendGrid API** - [https://sendgrid.com/docs/api-reference/](https://sendgrid.com/docs/api-reference/)
- **Mailgun API** - [https://documentation.mailgun.com/en/latest/api_reference.html](https://documentation.mailgun.com/en/latest/api_reference.html)
- **Postmark API** - [https://postmarkapp.com/developer](https://postmarkapp.com/developer)

#### SMTP Configuration for Railway
If using SMTP on Railway, use these settings:

**For SSL (port 465):**
```bash
EMAIL_SERVICE=smtp
SMTP_HOST=your-smtp-host
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
```

**For TLS (port 587, recommended):**
```bash
EMAIL_SERVICE=smtp
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
```

**Important Railway Notes:**
- Ensure the `from:` address matches the authenticated SMTP user
- SMTP can silently fail on cloud platforms like Railway due to network restrictions
- The service includes timeout detection and comprehensive error logging
- Monitor email delivery carefully and implement retry logic for critical emails

### Testing Services

#### Ethereal Email (Recommended for Testing)
Ethereal Email provides a fake SMTP service perfect for testing:

1. Visit [ethereal.email](https://ethereal.email) to create test credentials
2. Set environment variables:
   ```bash
   EMAIL_SERVICE=ethereal
   ETHEREAL_USER=your-test-email@ethereal.email
   ETHEREAL_PASS=your-test-password
   ```
3. View sent emails at [ethereal.email/messages](https://ethereal.email/messages)

#### Mailtrap (Alternative Testing)
Mailtrap provides email testing with additional features:

1. Sign up at [mailtrap.io](https://mailtrap.io)
2. Get your SMTP credentials from the inbox settings
3. Set environment variables:
   ```bash
   EMAIL_SERVICE=mailtrap
   MAILTRAP_USER=your-mailtrap-username
   MAILTRAP_PASS=your-mailtrap-password
   MAILTRAP_FROM=test@example.com
   ```

### Getting a Gmail App Password
1. Enable 2-factor authentication on your Gmail account
2. Go to [Google App Passwords](https://support.google.com/accounts/answer/185833)
3. Generate a new app password for "Mail"
4. Use the 16-character password (without spaces) as `GMAIL_APP_PASSWORD`

## Enhanced Features

### Pre-Send Verification
Every email send operation now includes automatic transporter verification:
```typescript
// Automatic verification before each send
const result = await sendEmail('user@example.com', 'Subject', '<p>Content</p>');
console.log('Verified:', result.verified); // true if verification succeeded
```

### Comprehensive Error Handling
The service provides detailed error logging and handling:
- Full error details printed to console
- Error codes, responses, and stack traces logged
- Connection verification errors captured
- Timeout detection for silent failures
- Fallback warnings for unusual failure modes

### Timeout Protection
Emails have a 30-second timeout to prevent silent failures:
```typescript
// Automatic timeout protection
const result = await sendEmail('user@example.com', 'Subject', '<p>Content</p>');
if (!result.success && result.error.includes('timeout')) {
  console.log('Email timed out - possible network issue');
}
```

### Transport Information
Enhanced response includes transport details:
```typescript
const result = await sendEmail('user@example.com', 'Subject', '<p>Content</p>');
console.log('Transport:', result.transportType); // e.g., "Ethereal Email (Testing)"
console.log('Verified:', result.verified);
console.log('Message ID:', result.messageId);
```

## Usage
```typescript
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
```

### With Custom From Address
```typescript
const result = await sendEmail(
  'recipient@example.com',
  'Custom Sender Email',
  '<p>This email has a custom from address.</p>',
  '"Custom Name" <custom@example.com>'
);
```

### Service Functions
```typescript
import { 
  sendEmail, 
  verifyEmailConnection, 
  getEmailSender 
} from './services/email';

// Check if email service is configured and connected
const isConnected = await verifyEmailConnection();

// Get the configured sender email
const sender = getEmailSender();
```

## API Endpoints

### GET /api/email/status
Check the email service status and configuration.

**Response:**
```json
{
  "connected": true,
  "sender": "your-email@gmail.com",
  "configured": true,
  "timestamp": "2025-07-24T08:52:07.073Z"
}
```

### POST /api/email/send
Send an email through the API.

**Request:**
```json
{
  "to": "recipient@example.com",
  "subject": "Email Subject",
  "html": "<h1>Email Content</h1><p>HTML content here</p>",
  "from": "Optional custom from address"
}
```

**Response (Success):**
```json
{
  "success": true,
  "messageId": "<unique-message-id>",
  "timestamp": "2025-07-24T08:52:15.180Z"
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Error message here",
  "timestamp": "2025-07-24T08:52:15.180Z"
}
```

## Examples

### cURL Examples
```bash
# Check email service status
curl http://localhost:8080/api/email/status

# Send an email
curl -X POST http://localhost:8080/api/email/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "user@example.com",
    "subject": "Welcome to Arcanos!",
    "html": "<h1>Welcome!</h1><p>Thank you for using Arcanos.</p>"
  }'
```

### Integration Example
```typescript
// In your service or route handler
import { sendEmail } from '../services/email';

export async function sendWelcomeEmail(userEmail: string, userName: string) {
  const html = `
    <h1>Welcome to Arcanos, ${userName}!</h1>
    <p>Thank you for joining our platform.</p>
    <p>Best regards,<br>The Arcanos Team</p>
  `;
  
  const result = await sendEmail(
    userEmail,
    'Welcome to Arcanos!',
    html
  );
  
  if (!result.success) {
    console.error('Failed to send welcome email:', result.error);
  }
  
  return result;
}
```

## Testing

Run the demonstration script to test the email service:

```bash
npm run build
node dist/demo-email-service.js
```

This will show the configuration status and provide usage examples without actually sending emails (unless you have valid credentials configured).

## Security Notes

- Never commit real Gmail credentials to version control
- Use app passwords, not your regular Gmail password
- Store credentials in environment variables only
- The service includes connection verification to prevent misconfiguration
- Failed email attempts are logged for debugging

## Troubleshooting

### Common Issues

1. **"Username and Password not accepted"**
   - Ensure 2FA is enabled on your Gmail account
   - Use an app password, not your regular password
   - Check that GMAIL_USER and GMAIL_APP_PASSWORD are correctly set

2. **"GMAIL_USER and GMAIL_APP_PASSWORD environment variables are required"**
   - Make sure both environment variables are set in your .env file
   - Restart the server after adding environment variables

3. **"Email service not properly configured"**
   - Verify your .env file contains the required variables
   - Check that there are no typos in the environment variable names

### Debug Mode
The service includes detailed logging. Check the console output for:
- Service initialization messages
- Connection verification results
- Email sending attempts and results
- Error details with specific error codes