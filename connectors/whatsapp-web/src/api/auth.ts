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

    // Check timestamp (5 minute window)
    const requestTime = parseInt(timestamp, 10);
    const now = Math.floor(Date.now() / 1000);
    const timeDiff = Math.abs(now - requestTime);

    if (timeDiff > 300) {
      res.status(401).json({ error: 'Request timestamp too old or too far in future' });
      return;
    }

    // Verify HMAC signature
    const body = JSON.stringify(req.body);
    const message = `${timestamp}:${body}`;
    const expectedSignature = createHmac('sha256', sharedSecret).update(message).digest('hex');

    const providedSignature = signature.replace('sha256=', '');

    // Use timing-safe comparison
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

export function generateHMACSignature(
  body: unknown,
  timestamp: number,
  sharedSecret: string
): string {
  const message = `${timestamp}:${JSON.stringify(body)}`;
  const signature = createHmac('sha256', sharedSecret).update(message).digest('hex');
  return `sha256=${signature}`;
}
