/**
 * SSE HTTP entry point for the MCP Server.
 * Allows remote clients (e.g. mcporter on Mac) to connect via HTTP.
 *
 * Runs on MCP_SSE_PORT (default 3010).
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Pool } from 'pg';
import Redis, { RedisOptions } from 'ioredis';
import * as fs from 'fs';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { MCPServer } from './server';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://whatsappmcp:whatsappmcp_dev@localhost:5432/whatsappmcp';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_TLS_CA = process.env.REDIS_TLS_CA;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const LLM_BASE_URL = process.env.LLM_BASE_URL || '';
const LLM_CHAT_MODEL = process.env.LLM_CHAT_MODEL || '';
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'dev-encryption-key-change-in-production';
const CONNECTOR_SHARED_SECRET =
  process.env.CONNECTOR_SHARED_SECRET || 'dev-secret-change-in-production';
const CONNECTOR_URL = process.env.CONNECTOR_URL || 'http://whatsapp-connector:3001';
const SSE_PORT = parseInt(process.env.MCP_SSE_PORT || '3010', 10);
const AUTH_TOKEN = process.env.MCP_SSE_AUTH_TOKEN || '';

const HEARTBEAT_INTERVAL_MS = parseInt(process.env.SSE_HEARTBEAT_MS || '30000', 10);
const SESSION_MAX_AGE_MS = parseInt(process.env.SSE_MAX_AGE_MS || `${6 * 3600 * 1000}`, 10);
const TCP_KEEPALIVE_MS = parseInt(process.env.SSE_TCP_KEEPALIVE_MS || '60000', 10);

interface SessionRecord {
  transport: SSEServerTransport;
  ip: string;
  ua: string;
  createdAt: number;
  heartbeat: NodeJS.Timeout;
  maxAgeTimer: NodeJS.Timeout;
  cleanup: (reason: string) => void;
}

async function main() {
  const dbPool = new Pool({
    connectionString: DATABASE_URL,
    max: 30,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'mcp-sse',
  } as any);
  // Touch the pool once so we surface bad credentials at boot.
  await dbPool.query('SELECT 1');
  console.log('[SSE] Connected to database (pool max=30, statement_timeout=10s)');

  let redisOptions: RedisOptions = {};
  if (REDIS_URL.startsWith('rediss://') && REDIS_TLS_CA) {
    const ca = fs.readFileSync(REDIS_TLS_CA, 'utf-8');
    redisOptions = { tls: { ca, rejectUnauthorized: true } };
  }
  const redisClient = new Redis(REDIS_URL, redisOptions);
  console.log('[SSE] Connected to Redis');

  const mcpServer = new MCPServer(
    dbPool,
    redisClient,
    OPENAI_API_KEY,
    ENCRYPTION_KEY,
    CONNECTOR_SHARED_SECRET,
    CONNECTOR_URL,
    LLM_BASE_URL || undefined,
    LLM_CHAT_MODEL || undefined
  );

  const sessions = new Map<string, SessionRecord>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://localhost:${SSE_PORT}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check (no auth required)
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', transport: 'sse', sessions: sessions.size }));
      return;
    }

    // Bearer token auth (when MCP_SSE_AUTH_TOKEN is set)
    if (AUTH_TOKEN) {
      const authHeader = req.headers.authorization || '';
      if (authHeader !== `Bearer ${AUTH_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Admin: list active sessions
    if (url.pathname === '/admin/sessions' && req.method === 'GET') {
      const now = Date.now();
      const list = Array.from(sessions.entries()).map(([id, s]) => ({
        sessionId: id,
        ip: s.ip,
        ua: s.ua,
        ageMs: now - s.createdAt,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: list.length, sessions: list }, null, 2));
      return;
    }

    // Admin: force close a session
    const killMatch = url.pathname.match(/^\/admin\/sessions\/([^/]+)$/);
    if (killMatch && req.method === 'DELETE') {
      const id = killMatch[1];
      const s = sessions.get(id);
      if (!s) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session not found' }));
        return;
      }
      s.cleanup('admin-delete');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId: id }));
      return;
    }

    // SSE endpoint — client connects here to establish stream
    if ((url.pathname === '/sse' || url.pathname === '/') && req.method === 'GET') {
      const transport = new SSEServerTransport('/message', res);

      const ip = req.socket.remoteAddress || 'unknown';
      const ua = String(req.headers['user-agent'] || '').slice(0, 200);
      const createdAt = Date.now();

      // TCP keepalive: detect zombies (NAT, proxy crash) within a minute.
      try {
        req.socket.setKeepAlive(true, TCP_KEEPALIVE_MS);
        req.socket.setTimeout(0);
      } catch {
        /* ignore */
      }

      // SSE heartbeat: comment lines keep proxies / load balancers from
      // idling the connection out.
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          doCleanup('heartbeat-write-failed');
        }
      }, HEARTBEAT_INTERVAL_MS);

      const maxAgeTimer = setTimeout(() => doCleanup('max-age'), SESSION_MAX_AGE_MS);

      const doCleanup = (reason: string) => {
        if (sessions.delete(transport.sessionId)) {
          clearInterval(heartbeat);
          clearTimeout(maxAgeTimer);
          const ageSec = Math.round((Date.now() - createdAt) / 1000);
          console.log(
            `[SSE] Session ${transport.sessionId} ${reason} ip=${ip} age=${ageSec}s (${sessions.size} active)`
          );
          void transport.close().catch(() => {});
        }
      };

      sessions.set(transport.sessionId, {
        transport,
        ip,
        ua,
        createdAt,
        heartbeat,
        maxAgeTimer,
        cleanup: doCleanup,
      });

      transport.onclose = () => doCleanup('closed');
      req.on('close', () => doCleanup('req-closed'));
      res.on('close', () => doCleanup('res-closed'));
      req.on('error', () => doCleanup('req-error'));
      res.on('error', () => doCleanup('res-error'));

      console.log(
        `[SSE] New session ${transport.sessionId} ip=${ip} ua="${ua}" (${sessions.size} active)`
      );
      await mcpServer.getServer().connect(transport);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC messages here
    if (url.pathname === '/message' && req.method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      const s = sessionId ? sessions.get(sessionId) : undefined;
      if (!sessionId || !s) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing sessionId' }));
        return;
      }

      await s.transport.handlePostMessage(req, res);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  httpServer.listen(SSE_PORT, '0.0.0.0', () => {
    console.log(`[SSE] MCP SSE Server listening on port ${SSE_PORT}`);
    console.log(`[SSE] Connect: http://localhost:${SSE_PORT}/sse`);
    console.log(
      `[SSE] heartbeat=${HEARTBEAT_INTERVAL_MS}ms tcp-keepalive=${TCP_KEEPALIVE_MS}ms max-age=${SESSION_MAX_AGE_MS}ms`
    );
  });

  const shutdown = async (signal: string) => {
    console.log(`[SSE] ${signal} received, shutting down...`);
    for (const s of sessions.values()) s.cleanup(`shutdown-${signal}`);
    httpServer.close();
    await dbPool.end();
    await redisClient.quit();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(error => {
  console.error('[SSE] Fatal error:', error);
  process.exit(1);
});
