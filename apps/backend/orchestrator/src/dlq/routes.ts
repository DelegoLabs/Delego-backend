/**
 * DLQ API Routes
 * Issue #310
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, route } from '@delegolabs/utils';
import type { DLQService } from './service.js';
import type { ReplayRequest } from './types.js';

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    const MAX_BODY_SIZE = 1_048_576; // 1MB

    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('JSON body must be an object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

export function createDLQRoutes(dlqService: DLQService) {
  return [
    /**
     * POST /api/v1/admin/dlq/replay
     * Manually replay failed jobs
     */
    route('POST', '/api/v1/admin/dlq/replay', async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const body = await readJsonBody(req);
        const request = body as ReplayRequest;

        const results = await dlqService.replayJobs(request);

        json(res, 200, {
          data: {
            total: results.length,
            successful: results.filter((r) => r.success).length,
            failed: results.filter((r) => !r.success).length,
            results,
          },
          error: null,
        });
      } catch (error) {
        json(res, 500, {
          data: null,
          error: {
            code: 'DLQ_REPLAY_FAILED',
            message: error instanceof Error ? error.message : 'Failed to replay jobs',
          },
        });
      }
    }),

    /**
     * GET /api/v1/admin/dlq/circuit-breaker/:queueName
     * Get circuit breaker state for a queue
     */
    route('GET', '/api/v1/admin/dlq/circuit-breaker/:queueName', async (_req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => {
      const queueName = params?.queueName;
      if (!queueName) {
        json(res, 400, {
          data: null,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'queueName is required',
          },
        });
        return;
      }

      const state = dlqService.getCircuitBreakerState(queueName);

      if (!state) {
        json(res, 404, {
          data: null,
          error: {
            code: 'NOT_FOUND',
            message: `Circuit breaker not found for queue: ${queueName}`,
          },
        });
        return;
      }

      json(res, 200, {
        data: { queueName, ...state },
        error: null,
      });
    }),

    /**
     * POST /api/v1/admin/dlq/circuit-breaker/:queueName/reset
     * Reset circuit breaker for a queue
     */
    route('POST', '/api/v1/admin/dlq/circuit-breaker/:queueName/reset', async (_req: IncomingMessage, res: ServerResponse, params?: Record<string, string>) => {
      const queueName = params?.queueName;
      if (!queueName) {
        json(res, 400, {
          data: null,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'queueName is required',
          },
        });
        return;
      }

      dlqService.resetCircuitBreaker(queueName);

      json(res, 200, {
        data: { queueName, message: 'Circuit breaker reset successfully' },
        error: null,
      });
    }),
  ];
}
