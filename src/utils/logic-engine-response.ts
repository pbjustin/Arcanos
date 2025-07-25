import { Request, Response, NextFunction } from 'express';

/**
 * Validates and sends responses from the arcanosLogicEngine.
 * If the engine returns placeholder or empty content, a 500 error is sent.
 * Otherwise the data is returned with a 200 status.
 */
export function handleLogicEngineResponse(res: Response, engineResponse: any) {
  const message = (engineResponse?.message || '').toLowerCase();

  const isPlaceholder =
    !engineResponse?.data ||
    message.includes('processed successfully') ||
    message.includes('default') ||
    message.includes('ask endpoint');

  if (isPlaceholder) {
    return res.status(500).json({
      success: false,
      error:
        '⚠️ Placeholder or non-substantive response returned from logic engine.',
      rawResponse: engineResponse,
      hint: 'Check model output, logs, or missing handlers in fine-tune logic.'
    });
  }

  return res.status(200).json({
    success: true,
    data: engineResponse.data || engineResponse
  });
}

/**
 * Creates an Express handler around arcanosLogicEngine.
 * The provided engine function should match (query: string, mode?: string) => Promise<any>.
 */
export function createLogicEngineMiddleware(
  engine: (query: string, mode?: string) => Promise<any>
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { query, mode } = req.body;
      const engineResponse = await engine(query, mode);
      return handleLogicEngineResponse(res, engineResponse);
    } catch (error) {
      next(error);
    }
  };
}
