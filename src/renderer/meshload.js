// Turns model bytes into a three.js object. Shared by the thumbnail worker and
// the viewer. 3MF has its own reader so Bambu/Orca projects (objects split
// across files, per-part filaments, painted colours) open with every part in place.
import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { Unzip, UnzipInflate, unzipSync, strFromU8 } from 'fflate';

export const DEFAULT_COLOR = 0x9db2c4;

export function defaultMaterial(color = DEFAULT_COLOR, vertexColors = false) {
  return new THREE.MeshStandardMaterial({ color: vertexColors ? 0xffffff : color, vertexColors, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide, flatShading: false });
}

/** @returns {Promise<{object: THREE.Object3D, zUp: boolean, colored: boolean}>} */
export async function loadModel(url, ext, opts) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not read file (' + res.status + ')');
  const buf = await res.arrayBuffer();
  return parseModel(buf, ext, opts);
}

export function parseModel(buf, ext, opts = {}) {
  switch (ext) {
    case 'stl': {
      const g = new STLLoader().parse(buf);
      const colored = !!g.getAttribute('color');
      // STL normals are often missing or wrong; rebuild them from the triangles.
      g.deleteAttribute('normal');
      g.computeVertexNormals();
      return { object: new THREE.Mesh(g, defaultMaterial(DEFAULT_COLOR, colored)), zUp: true, colored };
    }
    case 'ply': {
      const g = new PLYLoader().parse(buf);
      const colored = !!g.getAttribute('color');
      if (!g.index && !g.getAttribute('normal')) g.computeVertexNormals();
      else g.computeVertexNormals();
      return { object: new THREE.Mesh(g, defaultMaterial(DEFAULT_COLOR, colored)), zUp: true, colored };
    }
    case 'obj': {
      const o = new OBJLoader().parse(new TextDecoder().decode(buf));
      let colored = false;
      o.traverse((m) => {
        if (!m.isMesh) return;
        const vc = !!m.geometry.getAttribute('color');
        colored = colored || vc;
        if (!m.geometry.getAttribute('normal')) m.geometry.computeVertexNormals();
        m.material = defaultMaterial(DEFAULT_COLOR, vc);
      });
      return { object: o, zUp: true, colored };
    }
    case 'glb':
    case 'gltf': {
      return new Promise((resolve, reject) => {
        new GLTFLoader().parse(buf, '', (g) => resolve({ object: g.scene, zUp: false, colored: true }), (e) => reject(new Error(e.message || 'Invalid glTF')));
      });
    }
    case 'fbx': {
      const o = new FBXLoader().parse(buf, '');
      return { object: o, zUp: false, colored: true };
    }
    case '3mf':
      return parse3mf(buf, opts);
    default:
      throw new Error('No 3D preview for .' + ext);
  }
}

// ---------------------------------------------------------------- 3MF
// Streaming reader: the ZIP is inflated and scanned chunk by chunk, so a project
// with hundreds of MB of mesh XML never has to exist as one string.
const MAX_TRIS = 40e6;

const attr = (s, name) => {
  const m = s.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return m ? m[1] : null;
};

function matrixFrom(str) {
  const m = new THREE.Matrix4();
  if (!str) return m;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length !== 12 || v.some(Number.isNaN)) return m;
  m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  return m;
}

function hexColor(c) {
  if (!c) return null;
  const m = c.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  return m ? new THREE.Color('#' + m[1]) : null;
}

// Bambu/Orca "paint_color": hex nibbles read back to front; a leaf nibble holds
// the extruder state in its top two bits (3 = "see next nibble + 3").
function paintState(code) {
  if (!code) return 0;
  const n = (i) => parseInt(code[code.length - 1 - i], 16);
  const first = n(0);
  if (Number.isNaN(first) || (first & 3) !== 0) return 0; // split triangle: keep the part colour
  const st = first >> 2;
  if (st < 3) return st;
  const next = code.length > 1 ? n(1) : 0;
  return Number.isNaN(next) ? 0 : next + 3;
}

class Grow {
  constructor(Type, n = 1 << 15) { this.a = new Type(n); this.n = 0; }
  need(k) {
    if (this.n + k <= this.a.length) return;
    const b = new this.a.constructor(Math.max(this.a.length * 2, this.n + k));
    b.set(this.a);
    this.a = b;
  }
  push3(x, y, z) { this.need(3); const a = this.a; a[this.n++] = x; a[this.n++] = y; a[this.n++] = z; }
  push(v) { this.need(1); this.a[this.n++] = v; }
  done() { return this.a.subarray(0, this.n); }
}

function modelParser(budget) {
  const out = { objects: new Map(), items: [], materials: new Map(), unit: 'millimeter' };
  let carry = '';
  let obj = null, pos = null, idx = null, paint = null, painted = false, matList = null;
  const reTag = /<(\/?[\w:]+)([^<>]*)>/g;
  const reV = /x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/;
  const reT = /v1="(\d+)"\s+v2="(\d+)"\s+v3="(\d+)"/;
  const rePaint = /paint_color="([^"]*)"/;
  const reP1 = /\sp1="(\d+)"/;

  function closeObject() {
    if (!obj) return;
    if (pos) obj.mesh = { positions: pos.done(), index: idx.done(), paint: painted ? paint.done() : null };
    out.objects.set(obj.id, obj);
    obj = null; pos = idx = paint = null; painted = false;
  }

  out.feed = (text, final) => {
    const s = carry ? carry + text : text;
    const cut = final ? s.length : s.lastIndexOf('>') + 1;
    carry = cut < s.length ? s.slice(cut) : '';
    reTag.lastIndex = 0;
    let m;
    while ((m = reTag.exec(s)) && m.index < cut) {
      let name = m[1];
      const a = m[2];
      if (name === 'vertex') {
        const v = reV.exec(a);
        if (v && pos) pos.push3(+v[1], +v[2], +v[3]);
        continue;
      }
      if (name === 'triangle') {
        const t = reT.exec(a);
        if (!t || !idx) continue;
        idx.push3(+t[1], +t[2], +t[3]);
        let p = 0;
        if (a.length > t[0].length + 4) {
          const pc = rePaint.exec(a);
          if (pc) p = paintState(pc[1]);
          else { const p1 = reP1.exec(a); if (p1) p = -(+p1[1]) - 1; }
          if (p) painted = true;
        }
        paint.push(p);
        if (++budget.tris > MAX_TRIS) throw new Error('3MF has too many triangles to preview');
        continue;
      }
      const colon = name.indexOf(':');
      if (colon > 0) name = (name[0] === '/' ? '/' : '') + name.slice(colon + 1);
      switch (name) {
        case 'model': { const u = attr(a, 'unit'); if (u) out.unit = u; break; }
        case 'basematerials': case 'colorgroup': matList = []; out.materials.set(attr(a, 'id'), matList); break;
        case 'base': if (matList) matList.push(hexColor(attr(a, 'displaycolor'))); break;
        case 'color': if (matList) matList.push(hexColor(attr(a, 'color'))); break;
        case 'object': {
          closeObject();
          const id = attr(a, 'id');
          if (id != null) obj = { id, pid: attr(a, 'pid'), pindex: attr(a, 'pindex'), components: [], mesh: null };
          break;
        }
        case 'mesh': if (obj) { pos = new Grow(Float32Array); idx = new Grow(Uint32Array); paint = new Grow(Int16Array); painted = false; } break;
        case '/object': closeObject(); break;
        case 'component': if (obj) obj.components.push({ objectid: attr(a, 'objectid'), path: attr(a, 'p:path') || attr(a, 'path'), transform: attr(a, 'transform') }); break;
        case 'item': if (attr(a, 'printable') !== '0') out.items.push({ objectid: attr(a, 'objectid'), path: attr(a, 'p:path'), transform: attr(a, 'transform') }); break;
        default: break;
      }
    }
    if (final) closeObject();
  };
  return out;
}

const norm3mf = (p) => p.replace(/^\//, '').toLowerCase();
const isModel = (n) => n.toLowerCase().endsWith('.model');
const isConfig = (n) => /(model_settings|project_settings)\.config$/i.test(n);

function read3mf(u8) {
  const models = new Map();
  const configs = {};
  const budget = { tris: 0 };
  let gcodeOnly = false;
  let failure = null;
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (file) => {
    if (/\.gcode$/i.test(file.name)) gcodeOnly = true;
    if (isModel(file.name)) {
      const parser = modelParser(budget);
      const dec = new TextDecoder('utf-8');
      models.set(norm3mf(file.name), parser);
      file.ondata = (err, chunk, final) => {
        if (failure) return;
        try { if (err) throw err; parser.feed(dec.decode(chunk, { stream: !final }), final); }
        catch (e) { failure = e; }
      };
      file.start();
    } else if (isConfig(file.name)) {
      const parts = [];
      file.ondata = (err, chunk, final) => {
        if (err) return;
        parts.push(chunk);
        if (final) configs[file.name] = strFromU8(parts.length === 1 ? parts[0] : concat(parts));
      };
      file.start();
    }
  };
  const STEP = 1 << 23;
  for (let i = 0; i < u8.length && !failure; i += STEP) uz.push(u8.subarray(i, Math.min(i + STEP, u8.length)), i + STEP >= u8.length);
  if (failure) throw failure;
  return { models, configs, gcodeOnly };
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Fallback for ZIP layouts the streaming reader cannot follow.
function read3mfWhole(u8) {
  const budget = { tris: 0 };
  const models = new Map();
  const configs = {};
  let gcodeOnly = false;
  const files = unzipSync(u8, { filter: (f) => { if (/\.gcode$/i.test(f.name)) gcodeOnly = true; return isModel(f.name) || isConfig(f.name); } });
  for (const [name, data] of Object.entries(files)) {
    if (isModel(name)) {
      const parser = modelParser(budget);
      const dec = new TextDecoder('utf-8');
      const STEP = 1 << 24;
      for (let i = 0; i < data.length; i += STEP) parser.feed(dec.decode(data.subarray(i, Math.min(i + STEP, data.length)), { stream: i + STEP < data.length }), i + STEP >= data.length);
      if (!data.length) parser.feed('', true);
      models.set(norm3mf(name), parser);
    } else configs[name] = strFromU8(data);
  }
  return { models, configs, gcodeOnly };
}

function parse3mf(buf, opts = {}) {
  const u8 = new Uint8Array(buf);
  let pack;
  try {
    pack = read3mf(u8);
    if (![...pack.models.values()].some((m) => m.objects.size)) pack = read3mfWhole(u8);
  } catch (e) {
    if (/too many triangles/.test(e.message)) throw e;
    pack = read3mfWhole(u8);
  }
  const { models, configs } = pack;
  let rootKey = models.has('3d/3dmodel.model') ? '3d/3dmodel.model' : null;
  if (!rootKey) rootKey = [...models.keys()].find((k) => models.get(k).items.length) || [...models.keys()][0];
  if (!rootKey) throw new Error('3MF contains no model');
  const root = models.get(rootKey);

  // Bambu / Orca: filament colours and per-object / per-part extruders
  let filaments = [];
  const extruderOf = new Map(); // "objId" or "objId/partId" -> extruder number
  for (const [name, text] of Object.entries(configs)) {
    if (/project_settings\.config$/i.test(name)) {
      try { filaments = (JSON.parse(text).filament_colour || []).map(hexColor); } catch { /* not JSON */ }
    } else {
      for (const o of text.matchAll(/<object\s+id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
        const firstPart = o[2].indexOf('<part');
        const head = firstPart < 0 ? o[2] : o[2].slice(0, firstPart);
        const e = head.match(/key="extruder"\s+value="(\d+)"/);
        if (e) extruderOf.set(o[1], +e[1]);
        for (const p of o[2].matchAll(/<part\s+id="(\d+)"[^>]*>([\s\S]*?)<\/part>/g)) {
          const pe = p[2].match(/key="extruder"\s+value="(\d+)"/);
          if (pe) extruderOf.set(o[1] + '/' + p[1], +pe[1]);
        }
      }
    }
  }
  const filamentColor = (n) => (n > 0 && filaments[n - 1]) || null;

  const group = new THREE.Group();
  let colored = false;
  const geomCache = new Map();
  const fallback = new THREE.Color(DEFAULT_COLOR);
  const flatMat = (color, vertexColors) => { const m = defaultMaterial(color, vertexColors); m.flatShading = true; return m; };

  function meshFor(modelKey, model, obj, baseColor) {
    const { positions, index, paint } = obj.mesh;
    let objColor = baseColor;
    if (!objColor && obj.pid && model.materials.has(obj.pid)) objColor = model.materials.get(obj.pid)[+obj.pindex || 0] || null;
    if (!paint || opts.light) {
      const key = modelKey + '#' + obj.id;
      let g = geomCache.get(key);
      if (!g) {
        g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        g.setIndex(new THREE.BufferAttribute(index, 1));
        geomCache.set(key, g);
      }
      if (objColor) colored = true;
      return new THREE.Mesh(g, flatMat(objColor ? objColor.getHex() : DEFAULT_COLOR, false));
    }
    // per-triangle colours: expand to a triangle soup with vertex colours
    const n = index.length;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const base = objColor || fallback;
    const mats = model.materials.get(obj.pid);
    for (let t = 0; t < n / 3; t++) {
      let c = base;
      const p = paint[t];
      if (p > 0) c = filamentColor(p) || base;
      else if (p < 0) c = (mats && mats[-p - 1]) || base;
      for (let k = 0; k < 3; k++) {
        const vi = index[t * 3 + k] * 3, o = (t * 3 + k) * 3;
        pos[o] = positions[vi]; pos[o + 1] = positions[vi + 1]; pos[o + 2] = positions[vi + 2];
        col[o] = c.r; col[o + 1] = c.g; col[o + 2] = c.b;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    colored = true;
    return new THREE.Mesh(g, flatMat(DEFAULT_COLOR, true));
  }

  function add(modelKey, objectId, matrix, rootObjId, depth) {
    const model = models.get(modelKey);
    const obj = model && model.objects.get(String(objectId));
    if (!obj || depth > 8) return;
    if (obj.mesh) {
      if (!obj.mesh.index.length) return;
      const ext = extruderOf.get(rootObjId + '/' + obj.id) ?? extruderOf.get(String(rootObjId));
      const mesh = meshFor(modelKey, model, obj, filamentColor(ext));
      mesh.applyMatrix4(matrix);
      group.add(mesh);
      return;
    }
    for (const c of obj.components) {
      const key = c.path ? norm3mf(c.path) : modelKey;
      add(key, c.objectid, matrix.clone().multiply(matrixFrom(c.transform)), rootObjId, depth + 1);
    }
  }

  const items = root.items.length ? root.items : [...root.objects.values()].map((o) => ({ objectid: o.id, transform: null }));
  for (const it of items) add(it.path ? norm3mf(it.path) : rootKey, it.objectid, matrixFrom(it.transform), it.objectid, 0);
  if (!group.children.length) throw new Error(pack.gcodeOnly ? 'Sliced project: it holds G-code only, no mesh' : '3MF contains no printable mesh');

  const scale = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }[root.unit] || 1;
  if (scale !== 1) group.scale.setScalar(scale);
  return { object: group, zUp: true, colored };
}

// ---------------------------------------------------------------- measurements
/**
 * Bounding box, area, volume and a signature used to spot the same mesh in
 * another file. Computed in the file's own coordinates.
 */
export function measure(object) {
  object.updateMatrixWorld(true);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), cr = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  let tris = 0, area = 0, vol = 0, sx = 0, sy = 0, sz = 0;
  object.traverse((m) => {
    if (!m.isMesh || !m.geometry) return;
    const pos = m.geometry.getAttribute('position');
    if (!pos) return;
    const idx = m.geometry.index;
    const n = idx ? idx.count : pos.count;
    const mw = m.matrixWorld;
    for (let i = 0; i + 2 < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      min.min(a).min(b).min(c); max.max(a).max(b).max(c);
      ab.subVectors(b, a); ac.subVectors(c, a); cr.crossVectors(ab, ac);
      area += cr.length() / 2;
      vol += a.dot(cr.crossVectors(b, c)) / 6;
      sx += a.x + b.x + c.x; sy += a.y + b.y + c.y; sz += a.z + b.z + c.z;
      tris++;
    }
  });
  if (!tris) return null;
  const k = tris * 3;
  const r = (v) => (Number.isFinite(v) ? Number(v.toPrecision(9)) : 0);
  return {
    triCount: tris, bx: r(max.x - min.x), by: r(max.y - min.y), bz: r(max.z - min.z),
    area: r(area), volume: r(Math.abs(vol)),
    meshHash: JSON.stringify([min.x, min.y, min.z, max.x, max.y, max.z, area, Math.abs(vol), sx / k, sy / k, sz / k].map(r)),
    movedHash: null,
  };
}

/** Wrap a loaded model so it stands on the ground plane, centred, Y-up. */
export function stage(model) {
  const holder = new THREE.Group();
  holder.add(model.object);
  if (model.zUp) holder.rotation.x = -Math.PI / 2;
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const center = box.getCenter(new THREE.Vector3());
  const outer = new THREE.Group();
  holder.position.set(-center.x, -box.min.y, -center.z);
  outer.add(holder);
  outer.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3());
  return { root: outer, size, radius: Math.max(size.length() / 2, 1e-6) };
}

export function disposeObject(o) {
  o.traverse((m) => {
    if (m.geometry) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) { for (const v of Object.values(mat)) if (v && v.isTexture) v.dispose(); mat.dispose(); }
  });
}
