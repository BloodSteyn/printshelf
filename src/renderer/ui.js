// Small DOM helpers shared by every view.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const P = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.600-7 10-7 10z"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  printer: '<path d="M7 8V4h10v4"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.900 4.900 7 7M17 17l2.100 2.100M4.900 19.100 7 17M17 7l2.100-2.100"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="m20 20-4.200-4.200"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.500" cy="7.500" r="1.200"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  left: '<path d="m15 6-6 6 6 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.300 5.700"/><path d="M20 4v7h-7"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  cube: '<path d="M12 3 4 7.500v9L12 21l8-4.500v-9z"/><path d="M4 7.500 12 12l8-4.500M12 12v9"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  spark: '<path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800z"/><path d="M19 16v4M17 18h4"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.800"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.010M4 12h.010M4 18h.010"/>',
  eye: '<path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  wire: '<path d="M12 3 4 7.500v9L12 21l8-4.500v-9z"/><path d="M4 7.500 20 16.500M20 7.500 4 16.500M12 3v18"/>',
};
export function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.7'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.classList.add('icon');
  s.innerHTML = P[name] || '';
  return s;
}

export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n >= 100 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
}
export const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const fmtNum = (n) => (n == null ? '' : Number(n).toLocaleString());
export function fmtDuration(sec) {
  const hrs = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return hrs ? `${hrs}h ${m}m` : `${m}m`;
}

export function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('out'), kind === 'error' ? 6000 : 3200);
  setTimeout(() => t.remove(), kind === 'error' ? 6400 : 3600);
}

export async function call(name, args) {
  try { return await window.api.tool(name, args); }
  catch (e) { toast(cleanErr(e), 'error'); throw e; }
}
export async function native(name, args) {
  try { return await window.api.native(name, args); }
  catch (e) { toast(cleanErr(e), 'error'); throw e; }
}
const cleanErr = (e) => String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const thumbUrl = (f) => `/thumb/${f.id}?v=${f.thumb_ver || 0}`;

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Anchored popover menu. items: [{label, icon, onClick, danger}] or DOM node. */
export function popover(anchor, content) {
  document.querySelectorAll('.popover').forEach((p) => p.remove());
  const box = h('div', { class: 'popover' });
  if (Array.isArray(content)) {
    for (const it of content) {
      if (it === '-') { box.append(h('div', { class: 'sep' })); continue; }
      box.append(h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), onClick: () => { box.remove(); it.onClick(); } }, it.icon ? icon(it.icon, 14) : null, it.label));
    }
  } else box.append(content);
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  box.style.left = Math.max(8, Math.min(r.left, innerWidth - bw - 8)) + 'px';
  box.style.top = (r.bottom + bh + 8 > innerHeight ? Math.max(8, r.top - bh - 4) : r.bottom + 4) + 'px';
  const close = (e) => { if (!box.contains(e.target) && e.target !== anchor) { box.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
  return box;
}

export function prompt(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, placeholder, class: 'input' });
    const done = (v) => { back.remove(); resolve(v); };
    const back = h('div', { class: 'modal-back', onMousedown: (e) => { if (e.target === back) done(null); } },
      h('form', { class: 'modal', onSubmit: (e) => { e.preventDefault(); done(input.value.trim() || null); } },
        h('h3', {}, title), input,
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn', onClick: () => done(null) }, 'Cancel'), h('button', { class: 'btn primary' }, 'OK'))));
    document.body.append(back);
    input.focus(); input.select();
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(null); });
  });
}
