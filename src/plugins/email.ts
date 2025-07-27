import fs from 'fs'
import path from 'path'
import { sendEmail } from '../services/email'

export interface EmailPayload {
  to: string
  subject: string
  html: string
  from?: string
}

export async function sendEmailPrimary(payload: EmailPayload) {
  return await sendEmail(payload.to, payload.subject, payload.html, payload.from)
}

export async function sendEmailFallback(payload: EmailPayload) {
  try {
    const dir = path.join(process.cwd(), 'storage', 'fallback-emails')
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const file = path.join(dir, `email_${Date.now()}.json`)
    fs.writeFileSync(file, JSON.stringify(payload, null, 2))
  } catch (err) {
    // ignore file system errors
  }
  return { success: false, error: 'Fallback email stored locally' }
}
