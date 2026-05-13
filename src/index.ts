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
// CUSTOM TRANSPORT: Streamable HTTP (NDJSON over a single POST request)
// ============================================================================
class StreamableHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private reqEnded = false;
  private pendingRequests = 0;

  constructor(
    private req: any,
    private res: any
  ) {}

  start(): Promise<void> {
    this.res.writeHead(200, {
      'Content-Type': 'application/json',
      'Transfer-Encoding': 'chunked',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    let buffer = '';

    this.req.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          try {
            const message = JSON.parse(line) as JSONRPCMessage;
            this.pendingRequests++;
            this.onmessage?.(message);
          } catch (error) {
            this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }

      if (buffer.trim()) {
        try {
          const message = JSON.parse(buffer.trim()) as JSONRPCMessage;
          this.pendingRequests++;
          this.onmessage?.(message);
          buffer = '';
        } catch {
          // Wait for more data
        }
      }
    });

    this.req.on('end', () => {
      this.reqEnded = true;
      if (buffer.trim()) {
        try {
          const message = JSON.parse(buffer.trim()) as JSONRPCMessage;
          this.pendingRequests++;
          this.onmessage?.(message);
        } catch {}
      }

      // Close only if there are no tools currently executing
      if (this.pendingRequests <= 0) {
        void this.close();
      }
    });

    this.req.on('error', (error: Error) => {
      this.onerror?.(error);
    });

    this.res.on('close', () => {
      this.onclose?.();
    });

    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.res.writableEnded) {
      this.res.end();
    }
    this.onclose?.();
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this.res.writableEnded) {
      try {
        // FIX: Safely stringify GCP objects. Google APIs return BigInts
        // which will crash standard JSON.stringify.
        const payload = JSON.stringify(message, (key, value) =>
          typeof value === 'bigint' ? value.toString() : value
        );

        this.res.write(payload + '\n');
      } catch (err) {
        log.error({ err }, 'Failed to stringify outgoing message');
        this.res.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: (message as any).id || null,
            error: { code: -32603, message: 'Internal JSON serialization error' },
          }) + '\n'
        );
      }

      // Decrement pending request counter if this is a response to a request
      if ('id' in message) {
        this.pendingRequests--;
      }

      // If the client ended their upload stream and we answered everything, close.
      if (this.reqEnded && this.pendingRequests <= 0) {
        void this.close();
      }
    }
    return Promise.resolve();
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

  // FIX: Restore Map functionality for proper SSE Session routing (fixes Inspector timeouts)
  const sseTransports: Map<string, SSEServerTransport> = new Map();

  const server = http.createServer((req, res) => {
    // 1. CORS Headers
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

    // 4. ROUTE: Streamable HTTP (Bidirectional POST)
    if (req.method === 'POST' && req.url === '/stream') {
      void (async () => {
        try {
          const connectionServer = new McpServer({
            name: 'gcnv-mcp',
            version: '1.0.0',
          });
          registerAllTools(connectionServer);

          const transport = new StreamableHttpTransport(req, res);
          await connectionServer.connect(transport);

          log.info('Client connected via Streamable HTTP');
        } catch (error) {
          log.error({ err: error }, 'Error handling Streamable HTTP connection');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        }
      })();
      return;
    }

    // 5. ROUTE: SSE GET (Initialization)
    else if (req.method === 'GET' && req.url === '/message') {
      void (async () => {
        try {
          const connectionServer = new McpServer({
            name: 'gcnv-mcp',
            version: '1.0.0',
          });
          registerAllTools(connectionServer);

          const transport = new SSEServerTransport('/message', res);

          // Store transport securely by sessionId
          const sessionId = transport.sessionId;
          sseTransports.set(sessionId, transport);

          transport.onclose = () => {
            sseTransports.delete(sessionId);
          };

          await connectionServer.connect(transport);
          log.info({ sessionId }, 'Client connected via SSE');
        } catch (error) {
          log.error({ err: error }, 'Error handling SSE HTTP connection');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        }
      })();
    }

    // 6. ROUTE: SSE POST (Message Receiving)
    else if (req.method === 'POST' && req.url?.startsWith('/message')) {
      try {
        // Enforce sessionId lookup
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
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          void (async () => {
            try {
              const parsedBody = body.trim() ? JSON.parse(body.trim()) : undefined;
              await transport.handlePostMessage(req, res, parsedBody);
            } catch (error) {
              log.error({ err: error }, 'Error parsing/handling POST body');
              if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error handling request');
              }
            }
          })();
        });
      } catch (error) {
        log.error({ err: error }, 'Error reading POST request');
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  });

  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, `MCP Server listening on http://0.0.0.0:${port}`);
    log.info(` -> SSE Endpoint: GET /message (POST /message?sessionId=... for replies)`);
    log.info(` -> Streamable HTTP Endpoint: POST /stream`);
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
