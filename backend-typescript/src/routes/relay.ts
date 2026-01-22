/**
 * Relay Route
 * GraphQL endpoint backed by graphql-relay schema
 */

import { Router, Request, Response } from 'express';
import { graphql, GraphQLSchema } from 'graphql';
import path from 'path';
import { logger } from '../logger';

const router = Router();
const schemaLoaderPath = path.resolve(process.cwd(), 'relay', 'schema-loader.js');
const fallbackPath = path.resolve(process.cwd(), 'relay', 'fallback.js');
const { getRelaySchema } = require(schemaLoaderPath) as { getRelaySchema: () => GraphQLSchema };
const { buildFallbackResponse } = require(fallbackPath) as {
  buildFallbackResponse: (reason: string, detail?: string) => Record<string, unknown>;
};

const MAX_QUERY_LENGTH = 20000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

router.post('/', async (req: Request, res: Response) => {
  const body = req.body;
  if (!isPlainObject(body)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Payload must be a JSON object'
    });
  }

  const { query, variables, operationName } = body as {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };

  if (typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'query is required'
    });
  }
  if (query.length > MAX_QUERY_LENGTH) {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'query exceeds maximum length'
    });
  }

  if (variables !== undefined && !isPlainObject(variables)) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'variables must be an object'
    });
  }

  if (operationName !== undefined && typeof operationName !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'operationName must be a string'
    });
  }

  try {
    const schema = getRelaySchema();
    const result = await graphql({
      schema,
      source: query,
      variableValues: variables as Record<string, unknown> | undefined,
      operationName: operationName as string | undefined,
      contextValue: {
        ip: req.ip,
        user: req.user
      }
    });

    const statusCode = result.errors && !result.data ? 400 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    const message = (error as Error).message;
    logger.error('Relay execution failed', { error: message });
    const fallback = buildFallbackResponse('relay_execution_failed', message);
    return res.status(500).json({
      error: 'Internal Server Error',
      fallback
    });
  }
});

export default router;
