#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

import { registerAllTools } from './registry/register-tools.js';
import { logger } from './logger.js';

const log = logger.child({});

// ============================================================================
// CUSTOM TRANSPORT: Stateless HTTP (Synchronous POST)
// Matches FastMCP's exact behavior for Gemini BYOMCP clients
// ============================================================================
class StatelessHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private pending = new Map<number | string, any>();
  private isInitialized = false;
  private cachedInitResult: any = null;

  async start(): Promise<void> {
    return Promise.resolve();
  }
  async close(): Promise<void> {
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if ('id' in message && message.id != null) {
      // Type guard: Check if this is a response containing a result
      if ('result' in message) {
        // Cache the initialize result to gracefully handle Cloud Run container reuse
        if (!this.isInitialized && message.result && (message.result as any).serverInfo) {
          this.cachedInitResult = message.result;
          this.isInitialized = true;
        }
      }

      const res = this.pending.get(message.id);
      if (res && !res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // Safely serialize GCP objects (like BigInts)
        res.end(JSON.stringify(message, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        this.pending.delete(message.id);
      }
    }
    return Promise.resolve();
  }

  handlePost(req: any, res: any, parsedBody: any) {
    if (parsedBody && 'id' in parsedBody) {
      // If Cloud Run reuses the container on a new session, intercept duplicate 'initialize'
      if (parsedBody.method === 'initialize' && this.isInitialized) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsedBody.id,
            result: this.cachedInitResult,
          })
        );
        return;
      }
      this.pending.set(parsedBody.id, res);
    }

    try {
      this.onmessage?.(parsedBody);
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        'Error processing message in MCP Server'
      );
    }

    // Handle notifications (like 'notifications/initialized') which have no ID
    if (!parsedBody || !('id' in parsedBody)) {
      if (!res.headersSent) {
        res.writeHead(200);
        res.end();
      }
    }
  }
}

// ============================================================================
// SERVER LOGIC
// ============================================================================

async function startStdioTransport(mcpServer: McpServer) {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log.info('MCP Server listening on stdio');

  await new Promise<void>((resolve, reject) => {
    const originalClose = transport.onclose;
    transport.onclose = () => {
      originalClose?.();
      resolve();
    };

    const originalError = transport.onerror;
    transport.onerror = (error) => {
      originalError?.(error);
      const message = error instanceof Error ? (error.message ?? '') : '';
      if (error instanceof SyntaxError && message.includes('Unexpected end of JSON input')) {
        log.debug({ err: error }, 'Ignored malformed/empty JSON on stdio');
        return;
      }
      log.error({ err: error }, 'Error on stdio transport');
      reject(error);
    };
  });
}

async function startHttpTransport(mcpServerTemplate: McpServer, port: number = 8080) {
  const http = await import('http');

  // 1. Setup the Global Stateless Transport (For Gemini BYOMCP)
  const globalStatelessServer = new McpServer({
    name: 'gcnv-mcp',
    version: '1.0.0',
  });
  registerAllTools(globalStatelessServer);
  const statelessTransport = new StatelessHttpTransport();
  await globalStatelessServer.connect(statelessTransport);

  // 2. Setup standard SSE Session Map (For Official MCP Inspector)
  const sseTransports: Map<string, SSEServerTransport> = new Map();

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // ====================================================================
    // ROUTE: Stateless HTTP (FastMCP Emulation for Gemini)
    // ====================================================================
    if (req.method === 'POST' && (req.url === '/mcp' || req.url === '/stream')) {
      let body = '';
      req.on('data', (chunk) => (body += chunk.toString()));
      req.on('end', () => {
        try {
          const parsedBody = body.trim() ? JSON.parse(body.trim()) : undefined;
          statelessTransport.handlePost(req, res, parsedBody);
        } catch (error) {
          log.error(
            { err: error instanceof Error ? error : new Error(String(error)) },
            'Error parsing stateless POST body'
          );
          if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Bad Request');
          }
        }
      });
      return;
    }

    // ====================================================================
    // ROUTE: SSE GET & POST (For Official MCP Inspector)
    // ====================================================================
    if (req.method === 'GET' && req.url === '/message') {
      void (async () => {
        try {
          const connectionServer = new McpServer({
            name: 'gcnv-mcp',
            version: '1.0.0',
          });
          registerAllTools(connectionServer);

          const transport = new SSEServerTransport('/message', res);
          const sessionId = transport.sessionId;
          sseTransports.set(sessionId, transport);

          transport.onclose = () => sseTransports.delete(sessionId);
          await connectionServer.connect(transport);
          log.info({ sessionId }, 'Client connected via SSE');
        } catch (error) {
          log.error(
            { err: error instanceof Error ? error : new Error(String(error)) },
            'Error handling SSE HTTP connection'
          );
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        }
      })();
    } else if (req.method === 'POST' && req.url?.startsWith('/message')) {
      try {
        const url = new URL(req.url, `http://${req.headers.host || '0.0.0.0'}`);
        const sessionId = url.searchParams.get('sessionId');

        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing sessionId parameter');
          return;
        }

        const transport = sseTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
          return;
        }

        let body = '';
        req.on('data', (chunk) => (body += chunk.toString()));
        req.on('end', () => {
          void (async () => {
            try {
              const parsedBody = body.trim() ? JSON.parse(body.trim()) : undefined;
              await transport.handlePostMessage(req, res, parsedBody);
            } catch (error) {
              log.error(
                { err: error instanceof Error ? error : new Error(String(error)) },
                'Error handling POST body'
              );
              if (!res.headersSent) res.writeHead(500).end('Error handling request');
            }
          })();
        });
      } catch {
        // Explicitly catching and ignoring parsing errors to satisfy ESLint
        if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, `MCP Server listening on http://0.0.0.0:${port}`);
    log.info(` -> Stateless Endpoint (For Gemini BYOMCP): POST /mcp`);
    log.info(` -> SSE Endpoint (For Inspector): GET /message`);
  });

  await new Promise<void>((resolve, reject) => {
    server.on('close', () => resolve());
    server.on('error', (error) => reject(error));
    process.on('SIGINT', () => server.close(() => resolve()));
    process.on('SIGTERM', () => server.close(() => resolve()));
  });
}

function parseArgs(): { transport: 'stdio' | 'http'; port?: number } {
  const args = process.argv.slice(2);
  let transport: 'stdio' | 'http' = process.env.PORT ? 'http' : 'stdio';
  let port: number | undefined = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--transport' || args[i] === '-t') {
      const value = args[i + 1];
      if (value === 'http' || value === 'sse' || value === 'stdio') {
        transport = value === 'sse' ? 'http' : value;
        i++;
      }
    } else if (args[i] === '--port' || args[i] === '-p') {
      const value = parseInt(args[i + 1], 10);
      if (!isNaN(value)) {
        port = value;
        i++;
      }
    }
  }

  return { transport, port };
}

async function main() {
  const { transport, port } = parseArgs();

  const mcpServer = new McpServer({
    name: 'gcnv-mcp',
    version: '1.0.0',
  });
  registerAllTools(mcpServer);

  if (transport === 'http') {
    await startHttpTransport(mcpServer, port);
  } else {
    await startStdioTransport(mcpServer);
  }
}

main().catch((error) => {
  log.fatal({ err: error }, 'Fatal server error');
  process.exit(1);
});
