# Email Service Documentation

## Overview
The Arcanos backend now includes a nodemailer-based email service that allows sending emails through Gmail SMTP. The service provides a simple `sendEmail(to, subject, html)` function that can be called from anywhere in the application.

## Configuration

### Environment Variables
Add the following environment variables to your `.env` file:

```bash
# Email Configuration (Gmail SMTP)
GMAIL_USER=your-email@gmail.com
GMAIL_APP_PASSWORD=your-16-character-app-password
EMAIL_FROM_NAME=Arcanos Backend
```

### Getting a Gmail App Password
1. Enable 2-factor authentication on your Gmail account
2. Go to [Google App Passwords](https://support.google.com/accounts/answer/185833)
3. Generate a new app password for "Mail"
4. Use the 16-character password (without spaces) as `GMAIL_APP_PASSWORD`

## Usage

### Basic Email Sending
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