import { Request, Response } from 'express';
import { sendEmail } from '../utils/sendEmail';

export async function sendEmailIntent(req: Request, res: Response) {
  const { to, subject, body } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'Missing required fields: to, subject, body.' });
  }

  const result = await sendEmail(to, subject, body);

  if (result.success) {
    return res.status(200).json({ message: 'Email sent successfully.', info: result.info });
  } else {
    return res.status(500).json({ error: result.error });
  }
}