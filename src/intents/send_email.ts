import { Request, Response } from 'express';
import { sendEmail } from '../services/email';

export async function sendEmailIntent(req: Request, res: Response) {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, body.' });
  }

  // Convert text body to HTML for the new service
  const htmlBody = body.replace(/\n/g, '<br>');
  
  const result = await sendEmail(to, subject, htmlBody);

  if (result.success) {
    return res.status(200).json({ 
      message: 'Email sent successfully.', 
      messageId: result.messageId,
      verified: result.verified,
      transportType: result.transportType
    });
  } else {
    return res.status(500).json({ error: result.error });
  }
}