// Full-window viewer: orbit a model before the slicer opens. Images, video and
// text companions open here too.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadModel, stage, disposeObject } from './meshload.js';
import { h, icon, fmtNum, fmtSize } from './ui.js';

const MESH = new Set(['stl', '3mf', 'obj', 'ply', 'glb', 'gltf', 'fbx']);
let current = null;

export function closeViewer() {
  const el = document.getElementById('viewer');
  if (current) { current.dispose(); current = null; }
  el.hidden = true;
  el.replaceChildren();
}

export function isViewerOpen() { return !document.getElementById('viewer').hidden; }

export async function openViewer(file, actions = {}) {
  closeViewer();
  const el = document.getElementById('viewer');
  el.hidden = false;
  const stageEl = h('div', { class: 'v-stage' });
  const tools = h('div', { class: 'row' });
  el.append(
    h('div', { class: 'v-bar' },
      h('button', { class: 'btn', onClick: closeViewer, title: 'Back to library (Esc)' }, icon('left', 14), 'Library'),
      h('div', { class: 'title' }, file.name),
      tools,
      actions.onSlicer && h('button', { class: 'btn primary', onClick: actions.onSlicer }, icon('external', 14), 'Open in slicer'),
      h('button', { class: 'btn', onClick: () => window.api.native('reveal', { id: file.id }) }, icon('folder', 14), 'Reveal')),
    stageEl);

  if (MESH.has(file.ext)) return openMesh(file, stageEl, tools);
  const media = h('div', { class: 'media' });
  stageEl.append(media);
  const url = `/file/${file.id}`;
  if (file.kind === 'image' || file.ext === 'svg') media.append(h('img', { src: url }));
  else if (file.kind === 'video') media.append(h('video', { src: url, controls: true, autoplay: true }));
  else if (['txt', 'md', 'markdown', 'gcode', 'gco', 'dxf'].includes(file.ext) && file.size < 3e6) {
    media.append(h('pre', {}, (await (await fetch(url)).text()).slice(0, 400000)));
  } else if (file.thumb_state === 1) {
    media.append(h('img', { src: `/thumb/${file.id}?v=${file.thumb_ver}`, style: { background: 'none', minWidth: '320px', imageRendering: 'auto' } }));
  } else {
    media.append(h('div', { class: 'empty' }, icon('file', 40), h('h2', {}, 'No preview for .' + file.ext),
      h('p', {}, 'This type is indexed and searchable. Open it in its own app to see it.'),
      h('button', { class: 'btn', onClick: () => window.api.native('open_default', { id: file.id }) }, 'Open with default app')));
  }
}

async function openMesh(file, stageEl, tools) {
  const loading = h('div', { class: 'v-load' }, h('div', { class: 'spin' }), `Loading ${fmtSize(file.size)}…`);
  stageEl.append(loading);
  const canvas = h('canvas');
  stageEl.append(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.NeutralToneMapping;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x55606c, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  scene.add(key);
  const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 10000);
  const controls = new OrbitControls(cam, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;

  let raf = 0, alive = true, model = null, dirty = true;
  const resize = () => {
    const w = stageEl.clientWidth, hh = stageEl.clientHeight;
    if (!w || !hh) return;
    renderer.setSize(w, hh, false);
    cam.aspect = w / hh;
    cam.updateProjectionMatrix();
    dirty = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stageEl);
  controls.addEventListener('change', () => { dirty = true; });
  const tick = () => {
    if (!alive) return;
    raf = requestAnimationFrame(tick);
    if (controls.update() || dirty) {
      key.position.copy(cam.position).add(new THREE.Vector3(0.4, 0.9, 0.2).multiplyScalar(cam.position.length()));
      renderer.render(scene, cam);
      dirty = false;
    }
  };
  current = {
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (model) disposeObject(model.object);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };

  try {
    model = await loadModel(`/file/${file.id}`, file.ext);
  } catch (e) {
    loading.replaceChildren(icon('file', 36), h('div', {}, 'Could not open this model: ' + (e.message || e)));
    return;
  }
  if (!alive) { disposeObject(model.object); return; }
  loading.remove();
  const st = stage(model);
  scene.add(st.root);
  const r = st.radius;
  const span = Math.max(st.size.x, st.size.z) * 1.6 + 20;
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(span, 1) / 3)));
  const div = Math.max(4, Math.min(80, Math.round(span / step)));
  const gridHelper = new THREE.GridHelper(div * step, div, 0x4a5766, 0x2a333d);
  gridHelper.position.y = -r * 0.0005;
  scene.add(gridHelper);
  cam.near = r / 200; cam.far = r * 200; cam.updateProjectionMatrix();
  const target = new THREE.Vector3(0, st.size.y / 2, 0);
  const dist = (r / Math.sin((cam.fov * Math.PI) / 360)) * 1.15;
  const view = (x, y, z) => {
    controls.target.copy(target);
    cam.position.copy(target).addScaledVector(new THREE.Vector3(x, y, z).normalize(), dist);
    cam.up.set(0, 1, 0);
    controls.update();
    dirty = true;
  };
  view(0.9, 0.62, 1);

  let wire = false;
  const wireBtn = h('button', { class: 'btn', title: 'Wireframe', onClick: () => {
    wire = !wire;
    wireBtn.classList.toggle('on', wire);
    st.root.traverse((m) => { if (m.isMesh) for (const mat of [].concat(m.material)) mat.wireframe = wire; });
    dirty = true;
  } }, icon('wire', 14));
  const gridBtn = h('button', { class: 'btn on', title: 'Ground grid', onClick: () => { gridHelper.visible = !gridHelper.visible; gridBtn.classList.toggle('on', gridHelper.visible); dirty = true; } }, icon('grid', 14));
  tools.append(
    h('div', { class: 'seg' },
      h('button', { onClick: () => view(0.9, 0.62, 1) }, 'Iso'),
      h('button', { onClick: () => view(0, 0, 1) }, 'Front'),
      h('button', { onClick: () => view(1, 0, 0) }, 'Side'),
      h('button', { onClick: () => view(0, 1, 0.0001) }, 'Top')),
    wireBtn, gridBtn);

  let tris = 0;
  st.root.traverse((m) => { if (m.isMesh) { const g = m.geometry; tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3; } });
  const mm = model.zUp ? [st.size.x, st.size.z, st.size.y] : [st.size.x, st.size.y, st.size.z];
  stageEl.append(
    h('div', { class: 'v-hint' }, 'Drag to rotate · right-drag to pan · scroll to zoom'),
    h('div', { class: 'v-info' }, `${fmtNum(Math.round(tris))} triangles`, h('br'), mm.map((v) => v.toFixed(1)).join(' × ') + ' mm'));
  resize();
  tick();
}
