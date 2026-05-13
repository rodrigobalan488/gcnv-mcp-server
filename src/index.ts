#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { registerAllTools } from './registry/register-tools.js';
import { logger } from './logger.js';

const log = logger.child({});

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
      // The stdio transport will throw a SyntaxError if it receives a blank
      // line or otherwise malformed JSON on stdin (for example when a user
      // accidentally hits Enter). Those are non-fatal and can be safely
      // ignored; keep the server alive and just log a warning.
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

  // Store transports by session ID to route POST requests
  // REPLACE the Map with a single global variable
  let activeTransport: SSEServerTransport | null = null;

  const server = http.createServer((req, res) => {
    // 1. CORS Headers (Crucial for Inspector)
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

    // Handle GET request to establish SSE stream
    if (req.method === 'GET' && req.url === '/message') {
      void (async () => {
        try {
          const connectionServer = new McpServer({
            name: 'gcnv-mcp',
            version: '1.0.0',
          });
          registerAllTools(connectionServer);

          // Create transport
          const transport = new SSEServerTransport('/message', res);

          // HARDCODE/OVERRIDE: Set this as the only active transport
          activeTransport = transport;

          transport.onclose = () => {
            if (activeTransport === transport) {
              activeTransport = null;
            }
          };

          await connectionServer.connect(transport);
        } catch (error) {
          log.error({ err: error }, 'Error handling HTTP connection');
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        }
      })();
    }

    // Handle POST request to receive messages
    else if (req.method === 'POST' && req.url?.startsWith('/message')) {
      // BYPASS: No need to parse the URL or look for sessionId!
      // Just check if we have an active stream running.
      if (!activeTransport) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('No active SSE connection found. Please GET /message first.');
        return;
      }

      try {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });

        req.on('end', () => {
          void (async () => {
            try {
              const parsedBody = body ? JSON.parse(body) : undefined;
              // Route directly to the active transport
              await activeTransport!.handlePostMessage(req, res, parsedBody);
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

  // ... rest of your listen/shutdown code ...

  server.listen(port, '0.0.0.0', () => {
    log.info({ port }, `MCP Server listening on http://0.0.0.0:${port}/message`);
  });

  await new Promise<void>((resolve, reject) => {
    server.on('close', () => {
      resolve();
    });

    server.on('error', (error) => {
      reject(error);
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      server.close(() => {
        resolve();
      });
    });

    process.on('SIGTERM', () => {
      server.close(() => {
        resolve();
      });
    });
  });
}

function parseArgs(): { transport: 'stdio' | 'http'; port?: number } {
  const args = process.argv.slice(2);

  // 1. Check for Cloud Run environment variables
  // If PORT is set, default to HTTP transport and use the env port.
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
