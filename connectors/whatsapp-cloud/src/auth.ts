/**
 * HMAC authentication middleware — copied from whatsapp-connector.
 * Used by auto-reply worker and mcp-whatsapp-brain to authenticate send requests.
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';

export interface AuthenticatedRequest extends Request {
  authenticated?: boolean;
}

export function createHMACAuth(sharedSecret: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-connector-signature'] as string;
    const timestamp = req.headers['x-connector-timestamp'] as string;

    if (!signature || !timestamp) {
      res.status(401).json({ error: 'Missing authentication headers' });
      return;
    }

    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - requestTime) > 300) {
      res.status(401).json({ error: 'Request timestamp too old' });
      return;
    }

    const body = JSON.stringify(req.body);
    const message = `${timestamp}:${body}`;
    const expectedSignature = createHmac('sha256', sharedSecret).update(message).digest('hex');
    const providedSignature = signature.replace('sha256=', '');

    if (providedSignature.length !== expectedSignature.length) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    const isValid = timingSafeEqual(Buffer.from(providedSignature), Buffer.from(expectedSignature));
    if (!isValid) {
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    req.authenticated = true;
    next();
  };
}
