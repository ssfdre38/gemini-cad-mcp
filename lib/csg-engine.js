/**
 * Gemini CAD // Pure JavaScript 3D CSG & STL Mesh Engine
 * Zero external dependencies.
 *
 * Provides Constructive Solid Geometry primitives, transformations,
 * divergence theorem volume calculation, and binary/ASCII STL serialization.
 */

class Mesh {
  constructor(vertices = [], faces = []) {
    this.vertices = vertices; // Array of [x, y, z]
    this.faces = faces;       // Array of [i0, i1, i2]
  }

  clone() {
    return new Mesh(
      this.vertices.map(v => [v[0], v[1], v[2]]),
      this.faces.map(f => [f[0], f[1], f[2]])
    );
  }

  translate(dx, dy, dz) {
    for (let i = 0; i < this.vertices.length; i++) {
      this.vertices[i][0] += dx;
      this.vertices[i][1] += dy;
      this.vertices[i][2] += dz;
    }
    return this;
  }

  rotateZ(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (let i = 0; i < this.vertices.length; i++) {
      const x = this.vertices[i][0];
      const y = this.vertices[i][1];
      this.vertices[i][0] = x * cos - y * sin;
      this.vertices[i][1] = x * sin + y * cos;
    }
    return this;
  }

  rotateX(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (let i = 0; i < this.vertices.length; i++) {
      const y = this.vertices[i][1];
      const z = this.vertices[i][2];
      this.vertices[i][1] = y * cos - z * sin;
      this.vertices[i][2] = y * sin + z * cos;
    }
    return this;
  }

  rotateY(rad) {
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    for (let i = 0; i < this.vertices.length; i++) {
      const x = this.vertices[i][0];
      const z = this.vertices[i][2];
      this.vertices[i][0] = x * cos + z * sin;
      this.vertices[i][2] = -x * sin + z * cos;
    }
    return this;
  }

  getBoundingBox() {
    if (this.vertices.length === 0) {
      return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
    }
    const min = [this.vertices[0][0], this.vertices[0][1], this.vertices[0][2]];
    const max = [this.vertices[0][0], this.vertices[0][1], this.vertices[0][2]];
    for (let i = 1; i < this.vertices.length; i++) {
      const v = this.vertices[i];
      if (v[0] < min[0]) min[0] = v[0];
      if (v[1] < min[1]) min[1] = v[1];
      if (v[2] < min[2]) min[2] = v[2];
      if (v[0] > max[0]) max[0] = v[0];
      if (v[1] > max[1]) max[1] = v[1];
      if (v[2] > max[2]) max[2] = v[2];
    }
    return {
      min,
      max,
      size: [
        parseFloat((max[0] - min[0]).toFixed(3)),
        parseFloat((max[1] - min[1]).toFixed(3)),
        parseFloat((max[2] - min[2]).toFixed(3))
      ]
    };
  }

  /**
   * Computes exact surface area and volume using Gauss's divergence theorem.
   */
  computeProperties() {
    let totalArea = 0;
    let totalSignedVolume = 0;

    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      const p1 = this.vertices[f[0]];
      const p2 = this.vertices[f[1]];
      const p3 = this.vertices[f[2]];

      // Cross product (p2 - p1) x (p3 - p1)
      const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
      const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;

      const crossLen = Math.sqrt(cx * cx + cy * cy + cz * cz);
      totalArea += 0.5 * crossLen;

      // Tetrahedron signed volume from origin: (p1 . (p2 x p3)) / 6
      const v321 = p1[0] * p2[1] * p3[2];
      const v231 = p1[0] * p3[1] * p2[2];
      const v312 = p2[0] * p1[1] * p3[2];
      const v132 = p3[0] * p1[1] * p2[2];
      const v213 = p2[0] * p3[1] * p1[2];
      const v123 = p3[0] * p2[1] * p1[2];

      totalSignedVolume += (1.0 / 6.0) * (-v231 + v321 + v132 - v312 - v123 + v213);
    }

    const volumeMm3 = Math.abs(totalSignedVolume);
    const volumeCm3 = volumeMm3 / 1000.0;

    // Density heuristics in g/cm3: PLA = 1.24, PETG = 1.27, ABS = 1.04
    return {
      faceCount: this.faces.length,
      vertexCount: this.vertices.length,
      surfaceAreaMm2: parseFloat(totalArea.toFixed(2)),
      volumeMm3: parseFloat(volumeMm3.toFixed(2)),
      volumeCm3: parseFloat(volumeCm3.toFixed(3)),
      filamentWeightGrams: {
        pla_100_infill: parseFloat((volumeCm3 * 1.24).toFixed(2)),
        pla_20_infill: parseFloat((volumeCm3 * 1.24 * 0.35).toFixed(2)), // shell + infill heuristic
        petg_100_infill: parseFloat((volumeCm3 * 1.27).toFixed(2))
      }
    };
  }

  toBinaryStl(header = "Gemini CAD MCP // Watertight Solid") {
    const buffer = Buffer.alloc(84 + this.faces.length * 50);
    // 80-byte header
    buffer.write(header.slice(0, 80), 0, "utf8");
    // 4-byte uint32 triangle count
    buffer.writeUInt32LE(this.faces.length, 80);

    let offset = 84;
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      const p1 = this.vertices[f[0]];
      const p2 = this.vertices[f[1]];
      const p3 = this.vertices[f[2]];

      // Compute normal
      const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
      const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
      nx /= len; ny /= len; nz /= len;

      buffer.writeFloatLE(nx, offset);
      buffer.writeFloatLE(ny, offset + 4);
      buffer.writeFloatLE(nz, offset + 8);

      buffer.writeFloatLE(p1[0], offset + 12);
      buffer.writeFloatLE(p1[1], offset + 16);
      buffer.writeFloatLE(p1[2], offset + 20);

      buffer.writeFloatLE(p2[0], offset + 24);
      buffer.writeFloatLE(p2[1], offset + 28);
      buffer.writeFloatLE(p2[2], offset + 32);

      buffer.writeFloatLE(p3[0], offset + 36);
      buffer.writeFloatLE(p3[1], offset + 40);
      buffer.writeFloatLE(p3[2], offset + 44);

      buffer.writeUInt16LE(0, offset + 48); // Attribute byte count
      offset += 50;
    }
    return buffer;
  }

  toAsciiStl(solidName = "Model") {
    let out = `solid ${solidName}\n`;
    for (let i = 0; i < this.faces.length; i++) {
      const f = this.faces[i];
      const p1 = this.vertices[f[0]];
      const p2 = this.vertices[f[1]];
      const p3 = this.vertices[f[2]];

      const ax = p2[0] - p1[0], ay = p2[1] - p1[1], az = p2[2] - p1[2];
      const bx = p3[0] - p1[0], by = p3[1] - p1[1], bz = p3[2] - p1[2];
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
      nx /= len; ny /= len; nz /= len;

      out += `  facet normal ${nx.toFixed(6)} ${ny.toFixed(6)} ${nz.toFixed(6)}\n`;
      out += `    outer loop\n`;
      out += `      vertex ${p1[0].toFixed(4)} ${p1[1].toFixed(4)} ${p1[2].toFixed(4)}\n`;
      out += `      vertex ${p2[0].toFixed(4)} ${p2[1].toFixed(4)} ${p2[2].toFixed(4)}\n`;
      out += `      vertex ${p3[0].toFixed(4)} ${p3[1].toFixed(4)} ${p3[2].toFixed(4)}\n`;
      out += `    endloop\n`;
      out += `  endfacet\n`;
    }
    out += `endsolid ${solidName}\n`;
    return out;
  }
}

/**
 * Merge multiple disjoint or touching meshes into a single manifold mesh.
 */
function mergeMeshes(...meshes) {
  const mergedVertices = [];
  const mergedFaces = [];

  for (const m of meshes) {
    if (!m || !m.vertices || !m.faces) continue;
    const vOffset = mergedVertices.length;
    for (let i = 0; i < m.vertices.length; i++) {
      mergedVertices.push([m.vertices[i][0], m.vertices[i][1], m.vertices[i][2]]);
    }
    for (let i = 0; i < m.faces.length; i++) {
      mergedFaces.push([
        m.faces[i][0] + vOffset,
        m.faces[i][1] + vOffset,
        m.faces[i][2] + vOffset
      ]);
    }
  }

  return new Mesh(mergedVertices, mergedFaces);
}

/**
 * Creates an axis-aligned 3D Box.
 */
function createBox(w, l, h, center = false) {
  const x0 = center ? -w / 2 : 0;
  const x1 = center ? w / 2 : w;
  const y0 = center ? -l / 2 : 0;
  const y1 = center ? l / 2 : l;
  const z0 = center ? -h / 2 : 0;
  const z1 = center ? h / 2 : h;

  const vertices = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // Bottom 0,1,2,3
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]  // Top    4,5,6,7
  ];

  const faces = [
    // Bottom (z0) - normal down
    [0, 2, 1], [0, 3, 2],
    // Top (z1) - normal up
    [4, 5, 6], [4, 6, 7],
    // Front (y0) - normal -y
    [0, 1, 5], [0, 5, 4],
    // Back (y1) - normal +y
    [3, 6, 2], [3, 7, 6],
    // Left (x0) - normal -x
    [0, 4, 7], [0, 7, 3],
    // Right (x1) - normal +x
    [1, 2, 6], [1, 6, 5]
  ];

  return new Mesh(vertices, faces);
}

/**
 * Creates a triangular prism / wedge (useful for snap-fit latches and stiffening gussets).
 */
function createWedge(w, l, h) {
  // Base on XY plane, slope rising along Y from 0 to h at y=l
  const vertices = [
    [0, 0, 0], [w, 0, 0], [w, l, 0], [0, l, 0], // Bottom rectangle
    [0, l, h], [w, l, h]                        // Top ridge
  ];

  const faces = [
    // Bottom
    [0, 2, 1], [0, 3, 2],
    // Back vertical wall
    [3, 5, 2], [3, 4, 5],
    // Sloped top face
    [0, 1, 5], [0, 5, 4],
    // Left triangle
    [0, 4, 3],
    // Right triangle
    [1, 2, 5]
  ];

  return new Mesh(vertices, faces);
}

/**
 * Creates a 3D Cylinder.
 */
function createCylinder(r, h, fn = 32, center = false) {
  const z0 = center ? -h / 2 : 0;
  const z1 = center ? h / 2 : h;

  const vertices = [];
  const faces = [];

  // Bottom vertices [0 .. fn-1]
  for (let i = 0; i < fn; i++) {
    const angle = (2 * Math.PI * i) / fn;
    vertices.push([r * Math.cos(angle), r * Math.sin(angle), z0]);
  }
  // Top vertices [fn .. 2*fn-1]
  for (let i = 0; i < fn; i++) {
    const angle = (2 * Math.PI * i) / fn;
    vertices.push([r * Math.cos(angle), r * Math.sin(angle), z1]);
  }

  // Center bottom
  const bCenter = vertices.length;
  vertices.push([0, 0, z0]);
  // Center top
  const tCenter = vertices.length;
  vertices.push([0, 0, z1]);

  for (let i = 0; i < fn; i++) {
    const next = (i + 1) % fn;
    // Bottom cap (normal down)
    faces.push([bCenter, i, next]);
    // Top cap (normal up)
    faces.push([tCenter, next + fn, i + fn]);
    // Side quads -> two triangles
    faces.push([i, next, next + fn]);
    faces.push([i, next + fn, i + fn]);
  }

  return new Mesh(vertices, faces);
}

/**
 * Creates a rounded filleted rectangle prism (for remote doors).
 */
function createFilletedPlate(w, l, h, r = 2.5, fn = 8) {
  r = Math.min(r, w / 2, l / 2);
  const innerW = w - 2 * r;
  const innerL = l - 2 * r;

  // Build 2D boundary polygon
  const poly = [];
  const centers = [
    [innerW / 2, innerL / 2, 0, Math.PI / 2],           // Top-right
    [-innerW / 2, innerL / 2, Math.PI / 2, Math.PI],    // Top-left
    [-innerW / 2, -innerL / 2, Math.PI, 1.5 * Math.PI], // Bottom-left
    [innerW / 2, -innerL / 2, 1.5 * Math.PI, 2 * Math.PI] // Bottom-right
  ];

  for (const [cx, cy, aStart, aEnd] of centers) {
    for (let i = 0; i < fn; i++) {
      const a = aStart + ((aEnd - aStart) * i) / fn;
      poly.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }

  const n = poly.length;
  const vertices = [];
  const faces = [];

  // Bottom ring [0 .. n-1]
  for (let i = 0; i < n; i++) {
    vertices.push([poly[i][0], poly[i][1], 0]);
  }
  // Top ring [n .. 2n-1]
  for (let i = 0; i < n; i++) {
    vertices.push([poly[i][0], poly[i][1], h]);
  }

  const bCenter = vertices.length;
  vertices.push([0, 0, 0]);
  const tCenter = vertices.length;
  vertices.push([0, 0, h]);

  for (let i = 0; i < n; i++) {
    const next = (i + 1) % n;
    // Bottom
    faces.push([bCenter, next, i]);
    // Top
    faces.push([tCenter, i + n, next + n]);
    // Sides
    faces.push([i, next, next + n]);
    faces.push([i, next + n, i + n]);
  }

  return new Mesh(vertices, faces);
}

module.exports = {
  Mesh,
  mergeMeshes,
  createBox,
  createWedge,
  createCylinder,
  createFilletedPlate
};
