/**
 * Gemini CAD // MCP HTTP, SSE & OpenAPI Server Transport
 * Zero external dependencies.
 *
 * Implements:
 * 1. Official MCP Server-Sent Events (SSE) Transport (/sse + /message)
 * 2. Direct HTTP JSON-RPC 2.0 Endpoint (/mcp + /)
 * 3. Standard OpenAPI 3.0 Schema (/openapi.json + /.well-known/ai-plugin.json) for Google Gemini Spark
 * 4. Direct REST Tool Execution (/tools/<toolName>)
 * 5. File Download Server (/download/<filename>)
 * 6. Full Cross-Origin Resource Sharing (CORS) for Gemini Web, Mobile, Spark & Extensions
 */

const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const { TOOLS, handleToolCall, SERVER_NAME, SERVER_VERSION } = require("./dispatcher.js");
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
        console.log(`   📐 GEMINI CAD MCP // UNIVERSAL SERVER ONLINE`);
        console.log(`=======================================================`);
        console.log(` • Local URL:          http://127.0.0.1:${this.port}/`);
        console.log(` • MCP SSE Endpoint:   http://127.0.0.1:${this.port}/sse`);
        console.log(` • Direct JSON-RPC:    http://127.0.0.1:${this.port}/mcp`);
        console.log(` • OpenAPI 3.0 Schema: http://127.0.0.1:${this.port}/openapi.json`);
        console.log(` • Health Check:       http://127.0.0.1:${this.port}/health`);
        console.log(` • Downloads:          http://127.0.0.1:${this.port}/download/<file>`);
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
    const proto = req.headers["x-forwarded-proto"] || "http";
    const host = req.headers.host || `127.0.0.1:${this.port}`;
    const parsedUrl = new URL(req.url, `${proto}://${host}`);
    const pathname = parsedUrl.pathname;
    const method = req.method.toUpperCase();
    const acceptHeader = (req.headers.accept || "").toLowerCase();

    console.log(`[HTTP ${new Date().toISOString()}] ${method} ${pathname}${parsedUrl.search} | Accept: ${acceptHeader} | Host: ${host} | Proto: ${proto}`);
    console.log(`[HTTP HEADERS]`, JSON.stringify(req.headers));

    // 1. Full CORS Preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 2. OpenAPI 3.0.0 Specification for Gemini Spark / Custom Extensions
    if ((pathname === "/openapi.json" || pathname === "/swagger.json") && method === "GET") {
      return this.sendJson(res, 200, this.generateOpenApiSpec(host, proto));
    }

    // 3. AI Plugin Manifest
    if ((pathname === "/.well-known/ai-plugin.json" || pathname === "/manifest.json") && method === "GET") {
      return this.sendJson(res, 200, {
        schema_version: "v1",
        name_for_model: "gemini_cad",
        name_for_human: "Gemini CAD 3D Printing",
        description_for_model: "Optical photo-to-CAD and parametric 3D print generator for replacement battery covers, brackets, knobs, and spacers.",
        description_for_human: "Design 3D printable replacement parts from photos with coin scale calibration.",
        auth: { type: "none" },
        api: { type: "openapi", url: `${proto}://${host}/openapi.json` },
        logo_url: `${proto}://${host}/download/logo.png`,
        contact_email: "ssfdre38@gmail.com"
      });
    }

    // 4. Direct REST Tool Execution (/tools/<toolName>)
    if (pathname.startsWith("/tools/") && method === "POST") {
      const toolName = pathname.replace("/tools/", "");
      const body = await this.readBodyJson(req);
      try {
        const enhancedArgs = Object.assign({}, body || {}, { outputDir: this.outputDir });
        const result = await handleToolCall(toolName, enhancedArgs);
        this.injectDownloadUrls(result, host, proto);
        return this.sendJson(res, 200, { success: true, result });
      } catch (err) {
        return this.sendJson(res, 400, { success: false, error: err.message });
      }
    }

    // 5. MCP SSE Stream Endpoint (/sse, or /mcp with text/event-stream)
    const isSseRequest = pathname === "/sse" || (pathname === "/mcp" && acceptHeader.includes("text/event-stream")) || (pathname === "/" && acceptHeader.includes("text/event-stream"));
    if (isSseRequest && method === "GET") {
      const sessionId = req.headers["mcp-session-id"] || parsedUrl.searchParams.get("sessionId") || crypto.randomUUID();
      res.setHeader("Mcp-Session-Id", sessionId);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Mcp-Session-Id": sessionId
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      this.sessions.set(sessionId, {
        res,
        createdAt: Date.now(),
        lastSeen: Date.now()
      });

      req.on("close", () => {
        console.log(`[SSE] Client closed stream for session ${sessionId}`);
        this.sessions.delete(sessionId);
      });

      // Only send legacy 'endpoint' event for legacy SSE (/sse)
      if (pathname === "/sse") {
        const endpointUri = `${proto}://${host}/message?sessionId=${sessionId}`;
        res.write(`event: endpoint\ndata: ${endpointUri}\n\n`);
        console.log(`[Legacy SSE] Initialized stream for session ${sessionId} -> ${endpointUri}`);
      } else {
        console.log(`[StreamableHTTP SSE] Initialized standalone stream for session ${sessionId} on ${pathname}`);
      }
      return;
    }

    // 6. MCP Message POST Endpoint (/message - Legacy SSE)
    if (pathname === "/message" && method === "POST") {
      const sessionId = req.headers["mcp-session-id"] || parsedUrl.searchParams.get("sessionId") || crypto.randomUUID();
      res.setHeader("Mcp-Session-Id", sessionId);
      const body = await this.readBodyJson(req);
      console.log(`[MCP /message REQ]`, JSON.stringify(body));

      if (!body) {
        return this.sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" }
        });
      }

      const rpcResponse = await this.dispatchRpc(body, host, proto);
      console.log(`[MCP /message RES]`, JSON.stringify(rpcResponse));

      // In legacy SSE, response is sent via SSE stream
      if (sessionId && this.sessions.has(sessionId) && rpcResponse !== null) {
        const session = this.sessions.get(sessionId);
        try {
          session.res.write(`event: message\ndata: ${JSON.stringify(rpcResponse)}\n\n`);
        } catch {}
      }

      if (rpcResponse === null) {
        res.writeHead(202, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "accepted" }));
      }
      // For legacy SSE, return 202 Accepted on POST since response was pushed to SSE
      res.writeHead(202, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "accepted" }));
    }

    // 7. Direct JSON-RPC Endpoint (/mcp or / or /rpc - StreamableHTTP)
    if ((pathname === "/mcp" || pathname === "/rpc" || pathname === "/") && method === "POST") {
      const sessionId = req.headers["mcp-session-id"] || crypto.randomUUID();
      res.setHeader("Mcp-Session-Id", sessionId);
      const body = await this.readBodyJson(req);
      console.log(`[MCP /mcp REQ]`, JSON.stringify(body));
      if (!body) {
        return this.sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error: Invalid JSON" }
        });
      }

      const rpcResponse = await this.dispatchRpc(body, host, proto);
      console.log(`[MCP /mcp RES]`, JSON.stringify(rpcResponse));

      if (rpcResponse === null) {
        res.writeHead(202, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ status: "accepted" }));
      }
      return this.sendJson(res, 200, rpcResponse);
    }

    // Session termination (DELETE /mcp or DELETE /message)
    if ((pathname === "/mcp" || pathname === "/message") && method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] || parsedUrl.searchParams.get("sessionId");
      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId);
        try { session.res.end(); } catch {}
        this.sessions.delete(sessionId);
      }
      res.setHeader("Mcp-Session-Id", sessionId || "");
      return this.sendJson(res, 200, { status: "closed" });
    }

    // 8. File Downloads (/download/<filename>)
    if (pathname.startsWith("/download/") && (method === "GET" || method === "HEAD")) {
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
      if (method === "HEAD") {
        return res.end();
      }
      return fs.createReadStream(filePath).pipe(res);
    }

    // 9. Health & Diagnostic Dashboard (GET / or GET /health or GET /mcp)
    if (pathname === "/health" || pathname === "/" || pathname === "/mcp") {
      return this.sendJson(res, 200, {
        status: "healthy",
        server: SERVER_NAME,
        version: SERVER_VERSION,
        timestamp: new Date().toISOString(),
        endpoints: {
          mcpSse: `${proto}://${host}/sse`,
          mcpRpc: `${proto}://${host}/mcp`,
          openApi: `${proto}://${host}/openapi.json`,
          pluginManifest: `${proto}://${host}/.well-known/ai-plugin.json`,
          download: `${proto}://${host}/download/`
        },
        toolsCount: TOOLS.length,
        tools: TOOLS.map(t => ({ name: t.name, description: t.description }))
      });
    }

    // Fallback 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint not found" }));
  }

  async dispatchRpc(req, host, proto) {
    if (Array.isArray(req)) {
      const responses = [];
      for (const singleReq of req) {
        const resp = await this.dispatchSingleRpc(singleReq, host, proto);
        if (resp !== null) responses.push(resp);
      }
      return responses;
    }
    return this.dispatchSingleRpc(req, host, proto);
  }

  async dispatchSingleRpc(req, host, proto) {
    const { id, method, params } = req || {};

    if (!method) {
      if (id === undefined || id === null) return null;
      return {
        jsonrpc: "2.0",
        id: id || null,
        error: { code: -32600, message: "Invalid Request: missing method" }
      };
    }

    // Handle notifications (client does not expect a response)
    const isNotification = id === undefined || id === null;
    if (isNotification && (method.startsWith("notifications/") || method === "initialized")) {
      console.log(`[MCP Notification Handled] ${method}`);
      return null;
    }

    try {
      if (method === "initialize") {
        const protocolVersion = params?.protocolVersion || "2025-11-25";
        return {
          jsonrpc: "2.0",
          id: id ?? null,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
              logging: {}
            },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
          }
        };
      }

      if (method === "ping") {
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      }

      if (method === "tools/list") {
        return { jsonrpc: "2.0", id: id ?? null, result: { tools: TOOLS } };
      }

      if (method === "resources/list") {
        return { jsonrpc: "2.0", id: id ?? null, result: { resources: [] } };
      }

      if (method === "resources/templates/list") {
        return { jsonrpc: "2.0", id: id ?? null, result: { resourceTemplates: [] } };
      }

      if (method === "prompts/list") {
        return { jsonrpc: "2.0", id: id ?? null, result: { prompts: [] } };
      }

      if (method === "roots/list") {
        return { jsonrpc: "2.0", id: id ?? null, result: { roots: [] } };
      }

      if (method === "logging/setLevel") {
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      }

      if (method === "completion/complete") {
        return { jsonrpc: "2.0", id: id ?? null, result: { completion: { values: [], hasMore: false } } };
      }

      if (method === "tools/call") {
        const { name, arguments: toolArgs } = params || {};
        console.log(`[MCP Tool Call Invoking] ${name} with args:`, JSON.stringify(toolArgs));
        try {
          const enhancedArgs = Object.assign({}, toolArgs, { outputDir: this.outputDir });
          const result = await handleToolCall(name, enhancedArgs);
          this.injectDownloadUrls(result, host, proto);

          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
                }
              ],
              isError: false
            }
          };
        } catch (toolErr) {
          console.error(`[MCP Tool Call Error] ${name}:`, toolErr.message);
          return {
            jsonrpc: "2.0",
            id: id ?? null,
            result: {
              content: [
                {
                  type: "text",
                  text: `Error executing ${name}: ${toolErr.message}`
                }
              ],
              isError: true
            }
          };
        }
      }

      if (isNotification) return null;

      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    } catch (err) {
      if (isNotification) return null;
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32603, message: `Internal error: ${err.message}` }
      };
    }
  }

  injectDownloadUrls(result, host, proto) {
    if (result && result.files && result.files.stlPath) {
      const stlBase = path.basename(result.files.stlPath);
      const scadBase = path.basename(result.files.scadPath);
      result.downloadUrls = {
        stl: `${proto}://${host}/download/${stlBase}`,
        scad: `${proto}://${host}/download/${scadBase}`
      };
    }
  }

  generateOpenApiSpec(host, proto) {
    const paths = {};

    for (const tool of TOOLS) {
      paths[`/tools/${tool.name}`] = {
        post: {
          summary: tool.description,
          operationId: tool.name,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: tool.inputSchema
              }
            }
          },
          responses: {
            "200": {
              description: "Successful CAD synthesis",
              content: {
                "application/json": {
                  schema: { type: "object" }
                }
              }
            }
          }
        }
      };
    }

    return {
      openapi: "3.0.0",
      info: {
        title: "Gemini CAD MCP & 3D Print Generator",
        version: SERVER_VERSION,
        description: "Optical photo-to-CAD and parametric 3D print generator for TV remote battery covers, brackets, knobs, and spacers with coin calibration."
      },
      servers: [
        {
          url: `${proto}://${host}`,
          description: "Gemini CAD Live Server"
        }
      ],
      paths
    };
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
