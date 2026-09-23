#!/usr/bin/env node

/**
 * Gemini CAD MCP Server
 * Model Context Protocol (MCP) server for Optical Photo-to-CAD,
 * Parametric OpenSCAD synthesis, and 3D Printable STL generation.
 *
 * Designed for Gemini, Antigravity, and Claude Desktop.
 * Zero external dependencies.
 */

const readline = require("readline");
const path = require("path");
const fs = require("fs");

const { generateBatteryCover } = require("./lib/generators/battery-cover.js");
const {
  TOOLS,
  handleToolCall,
  SERVER_NAME,
  SERVER_VERSION
} = require("./lib/dispatcher.js");

// -------------------------------------------------------------
// MCP Stdio Transport & JSON-RPC 2.0 Dispatcher
// -------------------------------------------------------------

function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) return;

    let req;
    try {
      req = JSON.parse(line);
    } catch (err) {
      sendResponse(null, {
        code: -32700,
        message: "Parse error: Invalid JSON"
      });
      return;
    }

    const { id, method, params } = req;

    // Notifications (no id)
    if (id === undefined || id === null) {
      if (method === "notifications/initialized") {
        // Client confirmed initialization
      }
      return;
    }

    try {
      if (method === "initialize") {
        sendResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: SERVER_NAME,
            version: SERVER_VERSION
          }
        });
      } else if (method === "ping") {
        sendResult(id, {});
      } else if (method === "tools/list") {
        sendResult(id, { tools: TOOLS });
      } else if (method === "tools/call") {
        const { name, arguments: toolArgs } = params || {};
        try {
          const result = await handleToolCall(name, toolArgs || {});
          sendResult(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          });
        } catch (toolErr) {
          sendResult(id, {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error executing ${name}: ${toolErr.message}`
              }
            ]
          });
        }
      } else {
        sendResponse(id, {
          code: -32601,
          message: `Method not found: ${method}`
        });
      }
    } catch (err) {
      sendResponse(id, {
        code: -32603,
        message: `Internal error: ${err.message}`
      });
    }
  });
}

function sendResult(id, result) {
  const payload = {
    jsonrpc: "2.0",
    id,
    result
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

function sendResponse(id, error) {
  const payload = {
    jsonrpc: "2.0",
    id,
    error
  };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// -------------------------------------------------------------
// CLI Execution
// -------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Gemini CAD MCP Server v${SERVER_VERSION}
Model Context Protocol for Optical Photo-to-CAD & 3D Print Generation

Usage:
  node index.js               Run standard MCP server on stdio (Claude, Antigravity)
  node index.js --http        Run MCP HTTP & SSE server on port 18888 (Gemini App URL)
  node index.js --port 8080   Run HTTP & SSE server on custom port
  node index.js --check       Check host environment & OpenSCAD detection
  node index.js --demo        Generate a sample TV remote battery cover in ./output
`);
    process.exit(0);
  }

  // HTTP & SSE Server mode
  const portIndex = args.indexOf("--port");
  const customPort = portIndex !== -1 && args[portIndex + 1] ? Number(args[portIndex + 1]) : null;

  if (args.includes("--http") || args.includes("--sse") || customPort || process.env.PORT) {
    const { McpHttpServer } = require("./lib/http-server.js");
    const server = new McpHttpServer({ port: customPort });
    server.start().catch((err) => {
      console.error("Failed to start HTTP server:", err);
      process.exit(1);
    });
    return;
  }

  if (args.includes("--check")) {
    handleToolCall("cad_check_system", {}).then((info) => {
      console.log(JSON.stringify(info, null, 2));
      process.exit(0);
    });
    return;
  }

  if (args.includes("--demo")) {
    console.log("Generating sample TV Remote Battery Cover in ./output...");
    const res = generateBatteryCover({
      length: 62.4,
      width: 33.2,
      thickness: 1.6,
      clearance: 0.25,
      filename: "demo_tv_remote_battery_cover"
    });
    console.log("Generated:", res.files);
    console.log("Bounding Box:", res.dimensions.overallBoundingBoxMm);
    console.log("Filament Weight:", res.slicerAdvice.estimatedFilamentGrams, "grams");
    process.exit(0);
  }

  // Default: start MCP server on stdio
  startMcpServer();
}

module.exports = {
  TOOLS,
  handleToolCall
};
