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

const { calibrateScale, STANDARD_REFERENCES, FIT_TOLERANCES } = require("./lib/calibration.js");
const { generateBatteryCover } = require("./lib/generators/battery-cover.js");
const { generateBracket } = require("./lib/generators/bracket.js");
const { generateKnob } = require("./lib/generators/knob.js");
const { generateSpacer } = require("./lib/generators/spacer.js");
const { inspectStl } = require("./lib/stl-inspector.js");
const { findOpenScad, compileScadWithCli, renderPngWithCli } = require("./lib/openscad-cli.js");

const SERVER_NAME = "gemini-cad-mcp";
const SERVER_VERSION = "1.0.0";

const TOOLS = [
  {
    name: "cad_reference_calibration",
    description: "Calculates real-world millimeters from photo pixel measurements using a reference object (US Quarter 24.26mm, Penny 19.05mm, Credit Card, or Ruler). Also calculates 3D printing fit clearances (slide-fit, snap-fit).",
    inputSchema: {
      type: "object",
      properties: {
        referenceType: {
          type: "string",
          enum: ["quarter", "penny", "nickel", "dime", "euro_1", "euro_2", "uk_1pound", "credit_card_w", "credit_card_h", "ruler_mm", "custom_mm"],
          description: "Known reference object placed beside the part in the photo."
        },
        pixelSpan: {
          type: "number",
          description: "Pixel diameter or length of the reference object measured in the photo."
        },
        customRefMm: {
          type: "number",
          description: "Known reference dimension in mm if referenceType is 'custom_mm'."
        },
        measuredPixels: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              pixelSpan: { type: "number" }
            },
            required: ["label", "pixelSpan"]
          },
          description: "Optional list of features (e.g. cavity length, width, clip) to convert to millimeters."
        }
      },
      required: ["referenceType", "pixelSpan"]
    }
  },
  {
    name: "cad_generate_battery_cover",
    description: "Generates a complete parametric 3D-printable battery cover (TV remote, controller, toy) with cantilever snap-fit clip, alignment retention prongs, and grip ribs. Emits both human-editable OpenSCAD (.scad) code and ready-to-print watertight binary STL (.stl).",
    inputSchema: {
      type: "object",
      properties: {
        length: {
          type: "number",
          description: "Nominal cavity length in millimeters (e.g. 62.4)."
        },
        width: {
          type: "number",
          description: "Nominal cavity width in millimeters (e.g. 33.2)."
        },
        thickness: {
          type: "number",
          description: "Main plate wall thickness in mm (default: 1.6 mm - optimal for 0.4mm nozzle)."
        },
        cornerRadius: {
          type: "number",
          description: "Corner fillet radius in mm (default: 2.5 mm)."
        },
        clearance: {
          type: "number",
          description: "Printing clearance tolerance offset in mm (default: 0.25 mm for slide-fit)."
        },
        clipWidth: {
          type: "number",
          description: "Cantilever snap latch width in mm (default: 12.0 mm)."
        },
        clipLength: {
          type: "number",
          description: "Cantilever flex arm length in mm (default: 8.0 mm)."
        },
        hookOverhang: {
          type: "number",
          description: "Catch tooth latch depth in mm (default: 1.2 mm)."
        },
        tabLength: {
          type: "number",
          description: "Rear retention tab insertion depth in mm (default: 3.5 mm)."
        },
        tabWidth: {
          type: "number",
          description: "Rear retention tab width in mm (default: 8.0 mm)."
        },
        gripRibs: {
          type: "number",
          description: "Number of ergonomic thumb traction ridges (default: 5)."
        },
        outputDir: {
          type: "string",
          description: "Directory path where .scad and .stl files will be saved."
        },
        filename: {
          type: "string",
          description: "Base filename without extension."
        }
      },
      required: ["length", "width"]
    }
  },
  {
    name: "cad_generate_bracket",
    description: "Generates a parametric structural mounting bracket (L-bracket, flat plate) with mounting screw holes and reinforcing 45-degree gussets.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["L_bracket", "flat_plate"],
          description: "Bracket configuration."
        },
        leg1Length: {
          type: "number",
          description: "Base leg length in mm."
        },
        leg2Length: {
          type: "number",
          description: "Vertical leg length in mm."
        },
        width: {
          type: "number",
          description: "Bracket width in mm."
        },
        thickness: {
          type: "number",
          description: "Wall thickness in mm (default: 3.0 mm)."
        },
        holeDiameter: {
          type: "number",
          description: "Mounting screw hole diameter in mm (default: 4.5 mm for M4 screw)."
        },
        reinforcingGusset: {
          type: "boolean",
          description: "Whether to add 45-degree triangular stiffener gusset."
        },
        outputDir: { type: "string" },
        filename: { type: "string" }
      },
      required: ["leg1Length", "leg2Length", "width"]
    }
  },
  {
    name: "cad_generate_knob",
    description: "Generates a replacement rotary knob with D-shaft socket, perimeter fluting, and pointer indicator notch.",
    inputSchema: {
      type: "object",
      properties: {
        diameter: {
          type: "number",
          description: "Knob outer diameter in mm."
        },
        height: {
          type: "number",
          description: "Knob total height in mm."
        },
        shaftDiameter: {
          type: "number",
          description: "Potentiometer shaft diameter in mm (default: 6.0 mm)."
        },
        shaftType: {
          type: "string",
          enum: ["D_shaft", "round"],
          description: "Shaft profile (default: 'D_shaft')."
        },
        dFlatDepth: {
          type: "number",
          description: "Flat depth for D-shaft (default: 1.5 mm)."
        },
        knurlCount: {
          type: "number",
          description: "Number of grip flutes around perimeter (default: 18)."
        },
        indicatorNotch: {
          type: "boolean",
          description: "Whether to include indicator pointer notch."
        },
        outputDir: { type: "string" },
        filename: { type: "string" }
      },
      required: ["diameter", "height"]
    }
  },
  {
    name: "cad_generate_spacer",
    description: "Generates a round or hexagonal standoff, spacer, or bushing with a central through-hole.",
    inputSchema: {
      type: "object",
      properties: {
        outerDiameter: {
          type: "number",
          description: "Outer diameter (or across-flats for hex) in mm."
        },
        innerDiameter: {
          type: "number",
          description: "Through-hole diameter in mm (e.g. 4.5 mm for M4)."
        },
        height: {
          type: "number",
          description: "Spacer height in mm."
        },
        shape: {
          type: "string",
          enum: ["round", "hex"],
          description: "Cross-sectional shape (default: 'round')."
        },
        outputDir: { type: "string" },
        filename: { type: "string" }
      },
      required: ["outerDiameter", "innerDiameter", "height"]
    }
  },
  {
    name: "cad_inspect_stl",
    description: "Inspects a 3D STL mesh file for watertight manifoldness, triangle count, bounding box dimensions, volume, and estimated filament consumption in grams (PLA, PETG, ABS).",
    inputSchema: {
      type: "object",
      properties: {
        stlPath: {
          type: "string",
          description: "Path to the .stl file."
        }
      },
      required: ["stlPath"]
    }
  },
  {
    name: "cad_check_system",
    description: "Checks host environment for optional OpenSCAD CLI installation, default fit tolerances, and supported optical reference objects.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  }
];

async function handleToolCall(name, args) {
  switch (name) {
    case "cad_reference_calibration":
      return calibrateScale(args);

    case "cad_generate_battery_cover":
      return generateBatteryCover(args);

    case "cad_generate_bracket":
      return generateBracket(args);

    case "cad_generate_knob":
      return generateKnob(args);

    case "cad_generate_spacer":
      return generateSpacer(args);

    case "cad_inspect_stl":
      return inspectStl(args.stlPath);

    case "cad_check_system": {
      const openScadPath = findOpenScad();
      return {
        server: SERVER_NAME,
        version: SERVER_VERSION,
        openScadCli: {
          installed: Boolean(openScadPath),
          path: openScadPath || "Not installed (Embedded Pure JS CSG & STL generator active)"
        },
        standardReferences: STANDARD_REFERENCES,
        defaultFitTolerances: FIT_TOLERANCES
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

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
