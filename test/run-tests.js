#!/usr/bin/env node

/**
 * Gemini CAD MCP // Master Verification Test Suite
 * Tests optical calibration math, parametric generators, CSG engine,
 * STL mesh inspector, and MCP protocol tool handlers.
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { calibrateScale } = require("../lib/calibration.js");
const { generateBatteryCover } = require("../lib/generators/battery-cover.js");
const { generateBracket } = require("../lib/generators/bracket.js");
const { generateKnob } = require("../lib/generators/knob.js");
const { generateSpacer } = require("../lib/generators/spacer.js");
const { inspectStl } = require("../lib/stl-inspector.js");
const { TOOLS, handleToolCall } = require("../index.js");

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function it(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${name}`);
    console.error(`    \x1b[31m${err.message}\x1b[0m`);
    failedTests++;
  }
}

async function itAsync(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m ${name}`);
    console.error(`    \x1b[31m${err.message}\x1b[0m`);
    failedTests++;
  }
}

async function run() {
  console.log("\n=======================================================");
  console.log("   ⚡ GEMINI CAD MCP // TEST SUITE ⚡");
  console.log("=======================================================\n");

  const testOutputDir = path.join(__dirname, "test_output");
  if (!fs.existsSync(testOutputDir)) {
    fs.mkdirSync(testOutputDir, { recursive: true });
  }

  // Suite 1: Optical Scale Calibration
  console.log("\x1b[1m[Suite 1: Optical Reference Scale Calibration]\x1b[0m");

  it("Calibrates scale from US Quarter diameter (24.26mm)", () => {
    // 242.6 pixels across a quarter -> 0.1 mm per pixel
    const res = calibrateScale({
      referenceType: "quarter",
      pixelSpan: 242.6,
      measuredPixels: [
        { label: "cavity_length", pixelSpan: 624 },
        { label: "cavity_width", pixelSpan: 332 }
      ]
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.referenceMm, 24.26);
    assert.strictEqual(res.scale.mmPerPixel, 0.1);
    assert.strictEqual(res.measurements.length, 2);

    const len = res.measurements.find(m => m.label === "cavity_length");
    assert.strictEqual(len.rawMm, 62.4);
    // Slide fit offset = 0.25mm per side -> -0.5mm total
    assert.strictEqual(len.recommendedWithClearance.slide_fit, 61.9);
  });

  it("Calibrates scale from Custom Millimeter span", () => {
    const res = calibrateScale({
      referenceType: "custom_mm",
      customRefMm: 50.0,
      pixelSpan: 500
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.scale.mmPerPixel, 0.1);
  });

  it("Rejects zero or invalid pixel spans", () => {
    assert.throws(() => calibrateScale({ referenceType: "quarter", pixelSpan: 0 }), /Invalid pixelSpan/);
  });

  // Suite 2: Parametric Battery Cover Generator
  console.log("\n\x1b[1m[Suite 2: Parametric Battery Cover Generator]\x1b[0m");

  it("Generates TV remote battery cover OpenSCAD script and binary STL", () => {
    const res = generateBatteryCover({
      length: 62.4,
      width: 33.2,
      thickness: 1.6,
      cornerRadius: 2.5,
      clearance: 0.25,
      outputDir: testOutputDir,
      filename: "test_remote_battery_cover"
    });

    assert.strictEqual(res.success, true);
    assert(fs.existsSync(res.files.scadPath));
    assert(fs.existsSync(res.files.stlPath));
    assert(res.files.stlSizeBytes > 1000);

    const scadContent = fs.readFileSync(res.files.scadPath, "utf8");
    assert(scadContent.includes("module battery_cover()"));
    assert(scadContent.includes("cavity_length = 62.4"));
    assert(scadContent.includes("clearance     = 0.25"));

    // Check STL header
    const stlBuf = fs.readFileSync(res.files.stlPath);
    assert.strictEqual(stlBuf.length, res.files.stlSizeBytes);
    const triCount = stlBuf.readUInt32LE(80);
    assert(triCount > 50, `Expected > 50 triangles, got ${triCount}`);
  });

  // Suite 3: Parametric Bracket Generator
  console.log("\n\x1b[1m[Suite 3: Parametric Bracket Generator]\x1b[0m");

  it("Generates structural L-bracket with gusset", () => {
    const res = generateBracket({
      type: "L_bracket",
      leg1Length: 40.0,
      leg2Length: 40.0,
      width: 25.0,
      thickness: 3.5,
      reinforcingGusset: true,
      outputDir: testOutputDir,
      filename: "test_l_bracket"
    });

    assert.strictEqual(res.success, true);
    assert(fs.existsSync(res.files.scadPath));
    assert(fs.existsSync(res.files.stlPath));
    assert(res.dimensions.overallBoundingBoxMm[0] >= 25.0);
  });

  // Suite 4: Parametric Knob Generator
  console.log("\n\x1b[1m[Suite 4: Parametric Rotary Knob Generator]\x1b[0m");

  it("Generates fluted D-shaft potentiometer knob", () => {
    const res = generateKnob({
      diameter: 22.0,
      height: 15.0,
      shaftDiameter: 6.0,
      shaftType: "D_shaft",
      knurlCount: 16,
      outputDir: testOutputDir,
      filename: "test_rotary_knob"
    });

    assert.strictEqual(res.success, true);
    assert(fs.existsSync(res.files.stlPath));
    assert(res.meshProperties.faceCount > 100);
  });

  // Suite 5: Parametric Spacer Generator
  console.log("\n\x1b[1m[Suite 5: Parametric Spacer & Standoff Generator]\x1b[0m");

  it("Generates round washer spacer with through-hole", () => {
    const res = generateSpacer({
      outerDiameter: 12.0,
      innerDiameter: 4.5,
      height: 8.0,
      shape: "round",
      outputDir: testOutputDir,
      filename: "test_spacer_round"
    });

    assert.strictEqual(res.success, true);
    assert(fs.existsSync(res.files.stlPath));
    assert.strictEqual(res.dimensions.outerDiameter, 12.0);
    assert.strictEqual(res.dimensions.innerDiameter, 4.5);
  });

  // Suite 6: STL Mesh Inspector & Manifold Validator
  console.log("\n\x1b[1m[Suite 6: STL Mesh Inspector & Slicer Validator]\x1b[0m");

  it("Inspects generated battery cover STL and computes print metrics", () => {
    const stlFile = path.join(testOutputDir, "test_remote_battery_cover.stl");
    const report = inspectStl(stlFile);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.format, "Binary STL");
    assert(report.mesh.triangles > 50);
    assert(report.mesh.volumeCm3 > 0);
    assert(report.mesh.boundingBoxMm.widthX > 30);
    assert(report.mesh.boundingBoxMm.lengthY > 55);
    assert(report.filamentEstimateGrams.pla > 0);
    assert(report.printability.status.includes("Ready for Slicer"));
  });

  it("Inspects generated spacer STL", () => {
    const stlFile = path.join(testOutputDir, "test_spacer_round.stl");
    const report = inspectStl(stlFile);

    assert.strictEqual(report.success, true);
    assert.strictEqual(report.mesh.isWatertight, true);
    assert.strictEqual(report.mesh.openHoleEdges, 0);
  });

  // Suite 7: MCP Server Tool Registration & Dispatch
  console.log("\n\x1b[1m[Suite 7: MCP Server Tool Registry & Dispatcher]\x1b[0m");

  it("Exposes all expected CAD tools with valid schemas", () => {
    assert(Array.isArray(TOOLS));
    assert.strictEqual(TOOLS.length, 7);

    const names = TOOLS.map(t => t.name);
    assert(names.includes("cad_reference_calibration"));
    assert(names.includes("cad_generate_battery_cover"));
    assert(names.includes("cad_generate_bracket"));
    assert(names.includes("cad_generate_knob"));
    assert(names.includes("cad_generate_spacer"));
    assert(names.includes("cad_inspect_stl"));
    assert(names.includes("cad_check_system"));
  });

  await itAsync("Dispatches cad_check_system via handleToolCall", async () => {
    const res = await handleToolCall("cad_check_system", {});
    assert.strictEqual(res.server, "gemini-cad-mcp");
    assert.strictEqual(typeof res.openScadCli.installed, "boolean");
    assert(res.standardReferences.quarter !== undefined);
  });

  await itAsync("Dispatches cad_reference_calibration via handleToolCall", async () => {
    const res = await handleToolCall("cad_reference_calibration", {
      referenceType: "quarter",
      pixelSpan: 200
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.referenceMm, 24.26);
  });

  console.log("\n=======================================================");
  console.log(`   TEST RESULTS: ${passedTests}/${totalTests} PASSED (${failedTests} FAILED)`);
  console.log("=======================================================\n");

  if (failedTests > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test runner fatal error:", err);
  process.exit(1);
});
