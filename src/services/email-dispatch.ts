import { createServiceLogger } from '../utils/logger'
import { sendEmailPrimary, sendEmailFallback, EmailPayload } from '../plugins/email'
import { trackDiagnostics } from '../middleware/diagnostics'

const logger = createServiceLogger('EmailDispatch')

export async function dispatchEmail(payload: EmailPayload) {
  try {
    logger.info('Initiating primary email dispatch...')
    const result = await sendEmailPrimary(payload)
    logger.info('Primary dispatch successful', result)
    return result
  } catch (error: any) {
    logger.warning('Primary dispatch failed. Initiating fallback...', { error: error.message })
    const fallbackResult = await sendEmailFallback(payload)
    trackDiagnostics({ error, fallbackResult })
    logger.info('Fallback dispatch completed', fallbackResult)
    return fallbackResult
  }
}
