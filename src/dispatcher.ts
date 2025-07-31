// PATCH: Fix Dispatcher Recursion and Separate File I/O
// Ensures diagnostics and memory reads don't recurse through logic mode

import { handleLogic } from './routes/logic';
import { handleFileRead } from './routes/io';
import { Request, Response } from 'express';

export async function dispatcher(req: Request, res: Response) {
  try {
    const routeType = req.headers['x-request-type'] || 'logic';
    const payload = req.body;

    if (routeType === 'file') {
      // Bypass logic layer for safe diagnostics, memory, and I/O reads
      const result = await handleFileRead(payload);
      return res.json({ status: '✅ File I/O routed', result });
    }

    // Default logic handler
    const result = await handleLogic(payload);
    return res.json({ status: '✅ Logic executed', result });

  } catch (err: any) {
    return res.status(500).json({
      status: '❌ Dispatcher Error',
      message: err.message,
      stack: err.stack,
    });
  }
}
