// Posts ephemeral events (typing, inbound reactions) directly to the dashboard.
// Uses the same HMAC scheme the dashboard uses to call back into the connectors.

import { createHash, createHmac } from 'crypto';

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://100.83.56.98:9002';
const SECRET = process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';

function sign(body: string): { ts: string; sig: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = createHmac('sha256', SECRET).update(`${ts}:${body}`).digest('hex');
  return { ts, sig: `sha256=${sig}` };
}

export async function notifyDashboard(path: string, payload: Record<string, unknown>): Promise<void> {
  const body = JSON.stringify(payload);
  const { ts, sig } = sign(body);
  try {
    const ac = new AbortController();
    // Dashboard's asyncpg pool cold-starts can take 5-8s after a restart;
    // 4s was firing the abort before fetch had a chance. 12s leaves headroom
    // without holding the typing handler for too long.
    const timer = setTimeout(() => ac.abort(), 12000);
    const res = await fetch(`${DASHBOARD_URL}/api/messages${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-connector-signature': sig,
        'x-connector-timestamp': ts,
      },
      body,
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      // Don't throw — dashboard down shouldn't kill the connector loop.
      // eslint-disable-next-line no-console
      console.warn(`[dashboard-notifier] ${path} ${res.status}`);
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[dashboard-notifier] ${path} failed: ${(e as Error).message}`);
  }
}

// Suppress unused warning for createHash (kept for future use if we need to
// rotate to a hashed-payload contract).
void createHash;
