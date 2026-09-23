/**
 * OpenSCAD CLI Bridge (Optional)
 * Auto-detects local OpenSCAD installation across Windows, Linux, and macOS.
 * Can compile arbitrary .scad files to STL and render PNG camera snapshots.
 */

const { execSync, execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function findOpenScad() {
  const isWin = process.platform === "win32";
  const candidates = [];

  if (isWin) {
    candidates.push(
      "C:\\Program Files\\OpenSCAD\\openscad.exe",
      "C:\\Program Files (x86)\\OpenSCAD\\openscad.exe",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "OpenSCAD", "openscad.exe")
    );
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD",
      "/usr/local/bin/openscad",
      "/opt/homebrew/bin/openscad"
    );
  } else {
    candidates.push(
      "/usr/bin/openscad",
      "/usr/local/bin/openscad"
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // Check PATH
  try {
    const cmd = isWin ? "where.exe openscad" : "which openscad";
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length > 0 && fs.existsSync(lines[0])) {
      return lines[0];
    }
  } catch {}

  return null;
}

function compileScadWithCli(scadPath, stlPath) {
  const bin = findOpenScad();
  if (!bin) {
    return {
      success: false,
      installed: false,
      error: "OpenSCAD CLI not found on host. The embedded pure JS CSG engine is active as default."
    };
  }

  try {
    execFileSync(bin, ["-o", path.resolve(stlPath), path.resolve(scadPath)], { timeout: 30000 });
    return {
      success: true,
      installed: true,
      binPath: bin,
      stlPath: path.resolve(stlPath)
    };
  } catch (err) {
    return {
      success: false,
      installed: true,
      error: err.message
    };
  }
}

function renderPngWithCli(scadPath, pngPath, width = 800, height = 600) {
  const bin = findOpenScad();
  if (!bin) {
    return {
      success: false,
      installed: false,
      error: "OpenSCAD CLI required for headless PNG rasterization."
    };
  }

  try {
    execFileSync(
      bin,
      [
        "-o", path.resolve(pngPath),
        `--imgsize=${width},${height}`,
        "--autocenter",
        "--viewall",
        path.resolve(scadPath)
      ],
      { timeout: 30000 }
    );
    return {
      success: true,
      installed: true,
      pngPath: path.resolve(pngPath)
    };
  } catch (err) {
    return {
      success: false,
      installed: true,
      error: err.message
    };
  }
}

module.exports = {
  findOpenScad,
  compileScadWithCli,
  renderPngWithCli
};
