/**
 * Gemini CAD // MCP HTTP & SSE Server Transport
 * Zero external dependencies.
 *
 * Implements:
 * 1. Official MCP Server-Sent Events (SSE) Transport (/sse + /message)
 * 2. Direct HTTP JSON-RPC 2.0 Endpoint (/mcp + /)
 * 3. File Download Server (/download/<filename>)
 * 4. Full Cross-Origin Resource Sharing (CORS) for Gemini Web, Mobile & Extensions
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { TOOLS, handleToolCall } = require("../index.js");

const SERVER_NAME = "gemini-cad-mcp";
const SERVER_VERSION = "1.0.0";
const DEFAULT_PORT = 18888;

class McpHttpServer {
  constructor(options = {}) {
    this.port = Number(options.port || process.env.PORT || DEFAULT_PORT);
    this.host = options.host || "0.0.0.0";
    this.sessions = new Map(); // sessionId -> { res, createdAt, lastSeen }
    this.server = null;
    this.outputDir = path.resolve(options.outputDir || path.join(__dirname, "..", "output"));

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this.handleRequest(req, res);
        } catch (err) {
          this.sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: err.message }
          });
        }
      });

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[gemini-cad-mcp] Port ${this.port} in use, attempting ${this.port + 1}...`);
          this.port++;
          this.server.listen(this.port, this.host);
        } else {
          reject(err);
        }
      });

      this.server.listen(this.port, this.host, () => {
        console.log(`\n=======================================================`);
        console.log(`   📐 GEMINI CAD MCP // HTTP & SSE SERVER ONLINE`);
        console.log(`=======================================================`);
        console.log(` • Local URL:        http://127.0.0.1:${this.port}/`);
        console.log(` • MCP SSE Endpoint: http://127.0.0.1:${this.port}/sse`);
        console.log(` • Direct JSON-RPC:  http://127.0.0.1:${this.port}/mcp`);
        console.log(` • Health Check:     http://127.0.0.1:${this.port}/health`);
        console.log(` • Downloads:        http://127.0.0.1:${this.port}/download/<file>`);
        console.log(`=======================================================\n`);
        resolve(this);
      });

      // Keep-alive heartbeat loop for active SSE streams
      this.heartbeatTimer = setInterval(() => {
        for (const [id, session] of this.sessions.entries()) {
          try {
            session.res.write(": ping\n\n");
          } catch {
            this.sessions.delete(id);
          }
        }
      }, 15000);
    });
  }

  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const session of this.sessions.values()) {
      try { session.res.end(); } catch {}
    }
    this.sessions.clear();
    if (this.server) {
      return new Promise((resolve) => this.server.close(resolve));
    }
  }

  async handleRequest(req, res) {
    const host = req.headers.host || `127.0.0.1:${this.port}`;
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();

    // 1. CORS Preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Baggage, Sentry-Trace, Accept");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. Health & Diagnostic Dashboard
    if (pathname === "/health" || (pathname === "/" && method === "GET")) {
      const publicHost = req.headers.host || `127.0.0.1:${this.port}`;
      return this.sendJson(res, 200, {
        status: "healthy",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        timestamp: new Date().toISOString(),
        endpoints: {
          sse: `http://${publicHost}/sse`,
          message: `http://${publicHost}/message`,
          rpc: `http://${publicHost}/mcp`,
          download: `http://${publicHost}/download/`
        },
        toolsCount: TOOLS.length,
        tools: TOOLS.map(t => ({ name: t.name, description: t.description }))
      });
    }

    // 3. File Downloads (/download/<filename>)
    if (pathname.startsWith("/download/") && method === "GET") {
      const filename = path.basename(pathname.replace("/download/", ""));
      const filePath = path.join(this.outputDir, filename);

      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end(`File not found: ${filename}`);
      }

      const ext = path.extname(filename).toLowerCase();
      let contentType = "application/octet-stream";
      if (ext === ".stl") contentType = "model/stl";
      else if (ext === ".scad") contentType = "text/plain";
      else if (ext === ".png") contentType = "image/png";

      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": fs.statSync(filePath).size
      });
      return fs.createReadStream(filePath).pipe(res);
    }

    // 4. MCP SSE Stream Endpoint (/sse)
    if (pathname === "/sse" && method === "GET") {
      const sessionId = crypto.randomUUID();
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      this.sessions.set(sessionId, {
        res,
        createdAt: Date.now(),
        lastSeen: Date.now()
      });

      req.on("close", () => {
        this.sessions.delete(sessionId);
      });

      // Emit initial endpoint notification according to MCP spec
      const endpointUri = `/message?sessionId=${sessionId}`;
      res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
      return;
    }

    // 5. MCP Message POST Endpoint (/message)
    if (pathname === "/message" && method === "POST") {
      const sessionId = parsedUrl.searchParams.get("sessionId");
      const body = await this.readBodyJson(req);

      if (!body) {
        return this.sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" }
        });
      }

      const rpcResponse = await this.dispatchRpc(body, req);

      // Push response to SSE session if active
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId);
        try {
          session.res.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
        } catch {}
      }

      // Also return the RPC response on the POST response for broad client compatibility
      return this.sendJson(res, 200, rpcResponse);
    }

    // 6. Direct JSON-RPC Endpoint (/mcp or / or /rpc)
    if ((pathname === "/mcp" || pathname === "/rpc" || pathname === "/") && method === "POST") {
      const body = await this.readBodyJson(req);
      if (!body) {
        return this.sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" }
        });
      }

      const rpcResponse = await this.dispatchRpc(body, req);
      return this.sendJson(res, 200, rpcResponse);
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  async dispatchRpc(req, httpReq) {
    const { id, method, params } = req || {};

    if (!method) {
      return {
        jsonrpc: "2.0",
        id: id || null,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }

    try {
      if (method === "initialize") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }

      if (method === "tools/list") {
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
      }

      if (method === "tools/call") {
        const { name, arguments: toolArgs } = params || {};

        // Auto-inject download URL host into file responses
        const host = httpReq?.headers?.host || `127.0.0.1:${this.port}`;
        const enhancedArgs = Object.assign({}, toolArgs, {
          outputDir: this.outputDir
        });

        const result = await handleToolCall(name, enhancedArgs);

        // Add download URLs if files were created
        if (result && result.files && result.files.stlPath) {
          const stlBase = path.basename(result.files.stlPath);
          const scadBase = path.basename(result.files.scadPath);
          result.downloadUrls = {
            stl: `http://${host}/download/${stlBase}`,
            scad: `http://${host}/download/${scadBase}`
          };
        }

        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          }
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${err.message}` }
      };
    }
  }

  readBodyJson(req) {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data, null, 2));
  }
}

module.exports = {
  McpHttpServer,
  DEFAULT_PORT
};
