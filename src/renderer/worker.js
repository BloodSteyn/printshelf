// Hidden window: renders thumbnails and measures meshes, one file at a time,
// so the library window never stalls on a big model.
import * as THREE from 'three';
import { loadModel, measure, stage, disposeObject } from './meshload.js';

const SIZE = 384;
const canvas = document.createElement('canvas');
canvas.width = canvas.height = SIZE;
let renderer = null;

function getRenderer() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  return renderer;
}

const toPng = (cv) => new Promise((res) => cv.toBlob(async (b) => res(b ? new Uint8Array(await b.arrayBuffer()) : null), 'image/png'));

async function renderMesh(job) {
  const model = await loadModel(`/file/${job.id}`, job.ext, { light: !job.needThumb });
  let geom = null;
  if (job.needGeom) geom = measure(model.object);
  let thumb = null;
  if (job.needThumb) {
    const { root, radius } = stage(model);
    const scene = new THREE.Scene();
    scene.add(root);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x5b6470, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(1.2, 2.2, 1.6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd6ff, 0.9);
    rim.position.set(-2, 1, -1.5);
    scene.add(rim);
    const cam = new THREE.PerspectiveCamera(28, 1, radius / 50, radius * 40);
    const dir = new THREE.Vector3(0.9, 0.62, 1).normalize();
    const dist = (radius / Math.sin((cam.fov * Math.PI) / 360)) * 1.04;
    const box = new THREE.Box3().setFromObject(root);
    const target = box.getCenter(new THREE.Vector3());
    cam.position.copy(target).addScaledVector(dir, dist);
    cam.lookAt(target);
    getRenderer().render(scene, cam);
    thumb = await toPng(canvas);
    scene.remove(root);
  }
  disposeObject(model.object);
  return { thumb, geom };
}

function contain(w, h) {
  const s = Math.min(SIZE / w, SIZE / h, 4);
  return { w: w * s, h: h * s, x: (SIZE - w * s) / 2, y: (SIZE - h * s) / 2 };
}

async function renderImage(job) {
  const blob = await (await fetch(`/file/${job.id}`)).blob();
  const typed = job.ext === 'svg' ? new Blob([blob], { type: 'image/svg+xml' }) : blob;
  const url = URL.createObjectURL(typed);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 512, h = img.naturalHeight || 512;
    const cv = new OffscreenCanvas(SIZE, SIZE);
    const ctx = cv.getContext('2d');
    const r = contain(w, h);
    if (job.ext === 'svg') { ctx.fillStyle = '#f4f5f7'; ctx.fillRect(0, 0, SIZE, SIZE); }
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    return { thumb: new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer()) };
  } finally { URL.revokeObjectURL(url); }
}

// Line art from path segments: [[x1,y1,x2,y2,...], ...]
async function drawPaths(paths) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (let i = 0; i < p.length; i += 2) {
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1])) continue;
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]); minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
  }
  if (!Number.isFinite(minX)) throw new Error('Nothing to draw');
  const cv = new OffscreenCanvas(SIZE, SIZE);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, 0, SIZE, SIZE);
  const pad = 28;
  const s = Math.min((SIZE - pad * 2) / Math.max(maxX - minX, 1e-6), (SIZE - pad * 2) / Math.max(maxY - minY, 1e-6));
  const ox = (SIZE - (maxX - minX) * s) / 2, oy = (SIZE - (maxY - minY) * s) / 2;
  ctx.strokeStyle = '#1d2733';
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  return { cv, ctx, tx: (x) => ox + (x - minX) * s, ty: (y, flip) => (flip ? SIZE - oy - (y - minY) * s : oy + (y - minY) * s) };
}

async function renderDxf(job) {
  const text = await (await fetch(`/file/${job.id}`)).text();
  const lines = text.split(/\r?\n/);
  const paths = [];
  let inEntities = false;
  let ent = null;
  const flush = () => {
    if (!ent) return;
    const g = ent.g;
    if (ent.type === 'LINE') paths.push([g[10], g[20], g[11], g[21]]);
    else if (ent.type === 'CIRCLE' || ent.type === 'ARC') {
      const a0 = ent.type === 'ARC' ? (g[50] * Math.PI) / 180 : 0;
      let a1 = ent.type === 'ARC' ? (g[51] * Math.PI) / 180 : Math.PI * 2;
      if (a1 <= a0) a1 += Math.PI * 2;
      const p = [];
      for (let i = 0; i <= 48; i++) { const t = a0 + ((a1 - a0) * i) / 48; p.push(g[10] + g[40] * Math.cos(t), g[20] + g[40] * Math.sin(t)); }
      paths.push(p);
    } else if ((ent.type === 'LWPOLYLINE' || ent.type === 'SPLINE') && ent.xs.length > 1) {
      const p = [];
      for (let i = 0; i < Math.min(ent.xs.length, ent.ys.length); i++) p.push(ent.xs[i], ent.ys[i]);
      if (ent.type === 'LWPOLYLINE' && (g[70] & 1)) p.push(ent.xs[0], ent.ys[0]);
      paths.push(p);
    }
    ent = null;
  };
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    const val = lines[i + 1].trim();
    if (code === 2 && val === 'ENTITIES') { inEntities = true; continue; }
    if (!inEntities) continue;
    if (code === 0) {
      flush();
      if (val === 'ENDSEC') break;
      ent = { type: val, g: {}, xs: [], ys: [] };
    } else if (ent) {
      const n = parseFloat(val);
      if (code === 10) ent.xs.push(n);
      if (code === 20) ent.ys.push(n);
      if (!(code in ent.g)) ent.g[code] = n;
    }
  }
  flush();
  const d = await drawPaths(paths);
  for (const p of paths) {
    d.ctx.beginPath();
    for (let i = 0; i < p.length; i += 2) (i ? d.ctx.lineTo(d.tx(p[i]), d.ty(p[i + 1], true)) : d.ctx.moveTo(d.tx(p[i]), d.ty(p[i + 1], true)));
    d.ctx.stroke();
  }
  return { thumb: new Uint8Array(await (await d.cv.convertToBlob({ type: 'image/png' })).arrayBuffer()) };
}

// xTool Creative Space project: best effort, draws each element's outline box or path.
async function renderXcs(job) {
  const j = JSON.parse(await (await fetch(`/file/${job.id}`)).text());
  const displays = [];
  for (const c of j.canvas || []) for (const d of c.displays || []) displays.push(d);
  if (!displays.length) throw new Error('Empty project');
  const boxes = displays.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.width)).map((d) => [d.x, d.y, d.x + d.width, d.y, d.x + d.width, d.y + d.height, d.x, d.y + d.height, d.x, d.y]);
  const d0 = await drawPaths(boxes);
  for (const d of displays) {
    if (!Number.isFinite(d.x) || !Number.isFinite(d.width)) continue;
    const x = d0.tx(d.x), y = d0.ty(d.y), w = d0.tx(d.x + d.width) - x, h = d0.ty(d.y + d.height) - y;
    d0.ctx.beginPath();
    if (d.type === 'CIRCLE') d0.ctx.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
    else if (d.type === 'PATH' && d.dPath && d.graphicX !== undefined) {
      try {
        const p = new Path2D(d.dPath);
        const sx = (d0.tx(1) - d0.tx(0)) * (d.scale?.x ?? 1), sy = (d0.ty(1) - d0.ty(0)) * (d.scale?.y ?? 1);
        d0.ctx.save(); d0.ctx.translate(x, y); d0.ctx.scale(sx, sy); d0.ctx.translate(-d.graphicX, -d.graphicY);
        d0.ctx.lineWidth = 1.4 / Math.max(Math.abs(sx), 1e-6); d0.ctx.stroke(p); d0.ctx.restore();
        continue;
      } catch { d0.ctx.rect(x, y, w, h); }
    } else d0.ctx.rect(x, y, w, h);
    d0.ctx.stroke();
  }
  return { thumb: new Uint8Array(await (await d0.cv.convertToBlob({ type: 'image/png' })).arrayBuffer()) };
}

async function handle(job) {
  if (job.kind === 'image' || job.ext === 'svg') return renderImage(job);
  if (job.ext === 'dxf') return renderDxf(job);
  if (job.ext === 'xcs') return renderXcs(job);
  return renderMesh(job);
}

let running = false;
async function loop() {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = await window.api.workerNext();
      if (!job) break;
      let result;
      try { result = await handle(job); }
      catch (e) { result = { error: e && e.message ? e.message : String(e) }; }
      await window.api.workerDone(job.id, result);
      await new Promise((r) => setTimeout(r, 0));
    }
  } finally { running = false; }
}

window.api.on('worker-wake', loop);
setInterval(loop, 5000);
loop();
