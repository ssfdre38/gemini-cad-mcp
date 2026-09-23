/**
 * STL Mesh Inspector & 3D Printability Validator
 * Inspects both Binary and ASCII STL files for watertight manifoldness,
 * triangle count, bounding box, volume, and filament weight estimation.
 */

const fs = require("fs");
const path = require("path");

function inspectStl(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`STL file not found: ${resolvedPath}`);
  }

  const stat = fs.statSync(resolvedPath);
  const buffer = fs.readFileSync(resolvedPath);

  // Detect binary vs ASCII
  const isBinary = isBinaryStl(buffer, stat.size);
  let faces = [];
  let header = "";

  if (isBinary) {
    header = buffer.toString("utf8", 0, 80).replace(/\0/g, "").trim();
    const triangleCount = buffer.readUInt32LE(80);
    const expectedSize = 84 + triangleCount * 50;

    let offset = 84;
    for (let i = 0; i < triangleCount; i++) {
      if (offset + 50 > buffer.length) break;

      const p1 = [buffer.readFloatLE(offset + 12), buffer.readFloatLE(offset + 16), buffer.readFloatLE(offset + 20)];
      const p2 = [buffer.readFloatLE(offset + 24), buffer.readFloatLE(offset + 28), buffer.readFloatLE(offset + 32)];
      const p3 = [buffer.readFloatLE(offset + 36), buffer.readFloatLE(offset + 40), buffer.readFloatLE(offset + 44)];

      faces.push([p1, p2, p3]);
      offset += 50;
    }
  } else {
    // Parse ASCII STL
    const text = buffer.toString("utf8");
    const lines = text.split(/\r?\n/);
    header = lines[0] || "solid";

    let currentTri = [];
    for (let line of lines) {
      line = line.trim();
      if (line.startsWith("vertex ")) {
        const parts = line.split(/\s+/).slice(1).map(Number);
        if (parts.length >= 3 && !parts.some(isNaN)) {
          currentTri.push([parts[0], parts[1], parts[2]]);
          if (currentTri.length === 3) {
            faces.push(currentTri);
            currentTri = [];
          }
        }
      }
    }
  }

  // Bounding box, area, volume & edge manifold verification
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let totalArea = 0;
  let totalSignedVolume = 0;

  // Map for manifold edge check
  const edgeMap = new Map();

  function edgeKey(a, b) {
    const kA = `${a[0].toFixed(3)},${a[1].toFixed(3)},${a[2].toFixed(3)}`;
    const kB = `${b[0].toFixed(3)},${b[1].toFixed(3)},${b[2].toFixed(3)}`;
    return kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
  }

  for (const tri of faces) {
    const [p1, p2, p3] = tri;

    for (const p of [p1, p2, p3]) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[2] < minZ) minZ = p[2];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
      if (p[2] > maxZ) maxZ = p[2];
    }

    // Edges
    const e1 = edgeKey(p1, p2);
    const e2 = edgeKey(p2, p3);
    const e3 = edgeKey(p3, p1);
    edgeMap.set(e1, (edgeMap.get(e1) || 0) + 1);
    edgeMap.set(e2, (edgeMap.get(e2) || 0) + 1);
    edgeMap.set(e3, (edgeMap.get(e3) || 0) + 1);

    // Cross product
    const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
    const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    totalArea += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);

    // Signed volume from origin
    totalSignedVolume += (1.0 / 6.0) * (
      -p1[0] * p3[1] * p2[2] + p1[0] * p2[1] * p3[2] +
       p3[0] * p1[1] * p2[2] - p2[0] * p1[1] * p3[2] -
       p3[0] * p2[1] * p1[2] + p2[0] * p3[1] * p1[2]
    );
  }

  // Watertight verification:
  // In a closed watertight 3D solid (or composite multi-body assembly), every edge
  // has an even number of adjacent faces (2 for a single shell, 4+ for touching bodies).
  // An odd edge count indicates an unclosed hole or non-manifold seam.
  let openHoleEdges = 0;
  let compositeEdges = 0;
  for (const count of edgeMap.values()) {
    if (count % 2 !== 0) {
      openHoleEdges++;
    } else if (count > 2) {
      compositeEdges++;
    }
  }
  const isWatertight = openHoleEdges === 0;

  const dx = maxX !== -Infinity ? maxX - minX : 0;
  const dy = maxY !== -Infinity ? maxY - minY : 0;
  const dz = maxZ !== -Infinity ? maxZ - minZ : 0;

  const volumeMm3 = Math.abs(totalSignedVolume);
  const volumeCm3 = volumeMm3 / 1000.0;

  return {
    success: true,
    file: path.basename(resolvedPath),
    fileSizeBytes: stat.size,
    format: isBinary ? "Binary STL" : "ASCII STL",
    header,
    mesh: {
      triangles: faces.length,
      isWatertight,
      openHoleEdges,
      compositeEdges,
      boundingBoxMm: {
        widthX: parseFloat(dx.toFixed(2)),
        lengthY: parseFloat(dy.toFixed(2)),
        heightZ: parseFloat(dz.toFixed(2))
      },
      surfaceAreaMm2: parseFloat(totalArea.toFixed(2)),
      volumeCm3: parseFloat(volumeCm3.toFixed(3))
    },
    filamentEstimateGrams: {
      pla: parseFloat((volumeCm3 * 1.24 * 0.4).toFixed(2)),
      petg: parseFloat((volumeCm3 * 1.27 * 0.4).toFixed(2)),
      abs: parseFloat((volumeCm3 * 1.04 * 0.4).toFixed(2))
    },
    printability: {
      status: isWatertight ? "EXCELLENT // Ready for Slicer" : "WARNING // Open boundary holes detected",
      recommendedNozzleMm: 0.4,
      recommendedLayerHeightMm: 0.2
    }
  };
}

function isBinaryStl(buffer, fileSize) {
  if (fileSize < 84) return false;
  const faceCount = buffer.readUInt32LE(80);
  const expectedSize = 84 + faceCount * 50;
  // If exact binary formula matches, it is binary
  if (Math.abs(expectedSize - fileSize) <= 4) return true;
  // Check for "solid" keyword at start
  const startStr = buffer.toString("utf8", 0, Math.min(80, buffer.length));
  if (startStr.startsWith("solid ") && !buffer.includes(0x00)) return false;
  return true;
}

module.exports = {
  inspectStl
};
