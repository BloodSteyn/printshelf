// Generates a small test library in ./samples: primitives in several formats,
// deliberate duplicates, an archive, a slicer-style 3MF, G-code with an embedded
// preview, laser files and companion files.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { zipSync, strToU8 } = require('fflate');

const out = path.join(__dirname, '..', 'samples');
fs.rmSync(out, { recursive: true, force: true });
const w = (rel, data) => { const p = path.join(out, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };

// ---- meshes: { v: [[x,y,z]...], f: [[a,b,c]...] }
function box(sx, sy, sz) {
  const v = [[0, 0, 0], [sx, 0, 0], [sx, sy, 0], [0, sy, 0], [0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return { v, f };
}
function torus(R, r, n = 48, m = 24) {
  const v = [], f = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a = (i / n) * Math.PI * 2, b = (j / m) * Math.PI * 2;
    v.push([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b) + r]);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    const a = i * m + j, b = ((i + 1) % n) * m + j, c = ((i + 1) % n) * m + ((j + 1) % m), d = i * m + ((j + 1) % m);
    f.push([a, b, c], [a, c, d]);
  }
  return { v, f };
}
function sphere(r, n = 32, m = 16) {
  const v = [[0, 0, 0]], f = [];
  for (let j = 1; j < m; j++) for (let i = 0; i < n; i++) {
    const t = (j / m) * Math.PI, p = (i / n) * Math.PI * 2;
    v.push([r * Math.sin(t) * Math.cos(p), r * Math.sin(t) * Math.sin(p), r - r * Math.cos(t)]);
  }
  v.push([0, 0, 2 * r]);
  const top = v.length - 1;
  for (let i = 0; i < n; i++) {
    f.push([0, 1 + ((i + 1) % n), 1 + i]);
    f.push([top, 1 + (m - 2) * n + i, 1 + (m - 2) * n + ((i + 1) % n)]);
  }
  for (let j = 0; j < m - 2; j++) for (let i = 0; i < n; i++) {
    const a = 1 + j * n + i, b = 1 + j * n + ((i + 1) % n), c = 1 + (j + 1) * n + ((i + 1) % n), d = 1 + (j + 1) * n + i;
    f.push([a, b, c], [a, c, d]);
  }
  return { v, f };
}
function cone(r, h, n = 40) {
  const v = [[0, 0, 0], [0, 0, h]], f = [];
  for (let i = 0; i < n; i++) v.push([r * Math.cos((i / n) * 2 * Math.PI), r * Math.sin((i / n) * 2 * Math.PI), 0]);
  for (let i = 0; i < n; i++) { const a = 2 + i, b = 2 + ((i + 1) % n); f.push([0, b, a], [1, a, b]); }
  return { v, f };
}
const move = (m, dx, dy, dz) => ({ v: m.v.map(([x, y, z]) => [x + dx, y + dy, z + dz]), f: m.f });
const scale = (m, s) => ({ v: m.v.map((p) => p.map((c) => c * s)), f: m.f });
const rotZ = (m, deg) => { const a = (deg * Math.PI) / 180; return { v: m.v.map(([x, y, z]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a), z]), f: m.f }; };
const merge = (...ms) => { const v = [], f = []; for (const m of ms) { const o = v.length; v.push(...m.v); f.push(...m.f.map((t) => t.map((i) => i + o))); } return { v, f }; };

function stl(m) {
  const buf = Buffer.alloc(84 + m.f.length * 50);
  buf.write('sample', 0);
  buf.writeUInt32LE(m.f.length, 80);
  let o = 84;
  for (const [a, b, c] of m.f) {
    o += 12; // normal left zero
    for (const i of [a, b, c]) for (const x of m.v[i]) { buf.writeFloatLE(x, o); o += 4; }
    o += 2;
  }
  return buf;
}
const obj = (m) => '# sample\n' + m.v.map((p) => 'v ' + p.map((x) => x.toFixed(6)).join(' ')).join('\n') + '\n' + m.f.map((t) => 'f ' + t.map((i) => i + 1).join(' ')).join('\n') + '\n';
const meshXml = (m) => `<mesh><vertices>${m.v.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join('')}</vertices><triangles>${m.f.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh>`;

// ---- tiny PNG writer (solid gradient) for embedded previews
function png(size, rgbFn) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const [r, g, b] = rgbFn(x / size, y / size); const o = y * (size * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const disc = (c) => (x, y) => (Math.hypot(x - 0.5, y - 0.5) < 0.36 ? c : [34, 38, 46]);

// ---- files
const cube = box(20, 20, 20);
const bracket = merge(box(40, 12, 4), move(box(4, 12, 30), 0, 0, 4), move(box(4, 12, 30), 36, 0, 4));
const ring = torus(18, 5);
const ball = sphere(12);
const spike = cone(10, 28);
const totem = merge(box(24, 24, 6), move(sphere(9), 12, 12, 6), move(cone(6, 14), 12, 12, 22));

w('Calibration/calibration_cube.stl', stl(cube));
w('Calibration/calibration_cube.obj', obj(cube));                       // identical geometry, other format
w('Downloads dump/calibration_cube (1).stl', stl(cube));                // exact copy
w('Downloads dump/cube_moved.stl', stl(move(cube, 50, 30, 0)));         // same triangles, moved
w('Downloads dump/cube_rotated.stl', stl(rotZ(cube, 30)));              // same triangles, rotated
w('Downloads dump/download (7).stl', stl(ring));
w('Downloads dump/untitled(3).stl', stl(scale(ring, 1.5)));             // rescaled
w('Functional/shelf_bracket.stl', stl(bracket));
w('Functional/shelf_bracket_readme.txt', 'Print flat on the long side. 4 walls, 30% infill.\n');
w('Functional/photo_printed.png', png(96, disc([240, 150, 60])));
w('Toys/bouncy_ball.obj', obj(ball));
w('Toys/spinning_top.stl', stl(spike));
w('Toys/totem.stl', stl(totem));

// plain 3MF with base materials (two coloured objects)
const core3mf = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
  '3D/3dmodel.model': strToU8(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><metadata name="Application">PrusaSlicer-2.8.0</metadata><metadata name="Designer">Sample Maker</metadata><metadata name="License">CC BY 4.0</metadata><resources><basematerials id="1"><base name="red" displaycolor="#D9483B"/><base name="blue" displaycolor="#3B7DD9"/></basematerials><object id="2" type="model" pid="1" pindex="0">${meshXml(ball)}</object><object id="3" type="model" pid="1" pindex="1">${meshXml(spike)}</object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 0 0 0"/><item objectid="3" transform="1 0 0 0 1 0 0 0 1 30 0 0"/></build></model>`),
});
w('Toys/two_colour_set.3mf', Buffer.from(core3mf));

// Bambu-style project: objects in a separate file, per-part extruders, plate preview
const bambu = zipSync({
  '3D/3dmodel.model': strToU8(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><metadata name="Application">BambuStudio-02.01.00.59</metadata><resources><object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 0 0 0"/><component p:path="/3D/Objects/object_1.model" objectid="3" transform="1 0 0 0 1 0 0 0 1 12 12 6"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 100 0" printable="1"/></build></model>`),
  '3D/Objects/object_1.model': strToU8(`<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model">${meshXml(box(24, 24, 6))}</object><object id="3" type="model">${meshXml(sphere(9))}</object></resources></model>`),
  'Metadata/model_settings.config': strToU8('<?xml version="1.0"?><config><object id="2"><metadata key="name" value="totem"/><metadata key="extruder" value="1"/><part id="1" subtype="normal_part"><metadata key="extruder" value="1"/></part><part id="3" subtype="normal_part"><metadata key="extruder" value="2"/></part></object></config>'),
  'Metadata/project_settings.config': strToU8(JSON.stringify({ printer_model: 'Bambu Lab P1S', nozzle_diameter: ['0.4'], print_settings_id: '0.20mm Standard @BBL X1C', layer_height: '0.2', curr_bed_type: 'Textured PEI Plate', filament_colour: ['#7C3AED', '#FACC15'], filament_type: ['PLA', 'PLA'] })),
  'Metadata/slice_info.config': strToU8('<?xml version="1.0"?><config><plate><metadata key="prediction" value="2710"/><metadata key="weight" value="14.2"/><filament id="1" type="PLA" used_g="9.1"/><filament id="2" type="PLA" used_g="5.1"/></plate></config>'),
  'Metadata/plate_1.png': png(160, (x, y) => (Math.hypot(x - 0.5, y - 0.4) < 0.2 ? [250, 204, 21] : y > 0.55 && Math.abs(x - 0.5) < 0.3 ? [124, 58, 237] : [40, 44, 52])),
});
w('Toys/totem_multicolor.3mf', Buffer.from(bambu));

// G-code with an embedded preview
const b64 = png(64, disc([53, 208, 186])).toString('base64').match(/.{1,76}/g).map((l) => '; ' + l).join('\n');
w('Sliced/shelf_bracket_PLA_42m.gcode', `; generated by PrusaSlicer 2.8.0+win64\n; thumbnail begin 64x64 ${b64.length}\n${b64}\n; thumbnail end\nG28\nG1 X10 Y10 Z0.2 F3000\nG1 X50 E5\n; filament used [g] = 11.8\n; estimated printing time (normal mode) = 42m 10s\n; printer_model = MK4\n; nozzle_diameter = 0.4\n; layer_height = 0.2\n`);

// laser files
w('Laser/coaster.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="none" stroke="#111" stroke-width="2"/><path d="M50 14 L60 40 L88 42 L66 60 L74 88 L50 72 L26 88 L34 60 L12 42 L40 40 Z" fill="none" stroke="#111" stroke-width="2"/></svg>');
w('Laser/box_side.dxf', ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '90', '4', '70', '1', '10', '0', '20', '0', '10', '80', '20', '0', '10', '80', '20', '50', '10', '0', '20', '50', '0', 'CIRCLE', '10', '40', '20', '25', '40', '12', '0', 'LINE', '10', '10', '20', '10', '11', '70', '21', '40', '0', 'ENDSEC', '0', 'EOF'].join('\n'));

// an archive, plus the same pack already unpacked next to it
const pack = { 'Dragon Pack/ring.stl': stl(ring), 'Dragon Pack/parts/ball.obj': strToU8(obj(ball)), 'Dragon Pack/parts/top.stl': stl(spike), 'Dragon Pack/readme.md': strToU8('# Dragon Pack\nPersonal use only.\n') };
w('Packs/Dragon Pack.zip', Buffer.from(zipSync(Object.fromEntries(Object.entries(pack).map(([k, v]) => [k, new Uint8Array(v)])))));
for (const [k, v] of Object.entries(pack)) w('Packs/' + k, Buffer.from(v));
// the same pack again somewhere else -> whole-folder duplicate
for (const [k, v] of Object.entries(pack)) w('Backup/' + k, Buffer.from(v));

console.log('Sample library written to', out);
