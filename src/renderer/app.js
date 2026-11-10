import { h, icon, fmtSize, toast, call, native, thumbUrl, debounce, popover, prompt } from './ui.js';
import { openViewer, closeViewer, isViewerOpen } from './viewer.js';
import { renderDetail } from './detail.js';
import { pages } from './views.js';

const S = {
  view: 'library',
  scope: { type: 'all' },                 // all | favorites | collection{id,name}
  filter: { q: '', show: 'models', dir: null, flat: true, tags: [], sort: 'name', printed: '' },
  semantic: false,
  items: [], sel: new Set(), anchor: -1,
  cardSize: localStorage.cardSize || 'm',
  sources: [], stats: {}, slicers: [], settings: {}, tags: [],
  expanded: new Set(JSON.parse(localStorage.expanded || '[]')),
  scan: null, ai: null,
};
const $ = (id) => document.getElementById(id);
const CARD_MIN = { s: 132, m: 176, l: 240 };

// ------------------------------------------------------------------ actions
const A = {
  async openSlicer(ids, slicer) {
    if (!ids.length) return;
    const name = await native('open_slicer', { ids, slicer });
    toast(`Sent ${ids.length === 1 ? 'model' : ids.length + ' models'} to ${name}`);
  },
  slicerMenu(anchor, ids) {
    if (!S.slicers.length) return toast('No slicer found on this computer. Add one in Settings.', 'error');
    popover(anchor, S.slicers.map((s) => ({ label: s.name, icon: 'external', onClick: () => A.openSlicer(ids, s.name) })));
  },
  async favorite(ids, on) { await call('set_details', { ids, favorite: on }); },
  async printed(ids, on) { await call('set_details', { ids, printed: on }); },
  async queue(ids) { await call('print_queue_add', { ids }); toast(`Added ${ids.length} to the print queue`); refreshMeta(); },
  async addTags(ids) {
    const v = await prompt('Add tags', '', 'comma separated, e.g. dragon, articulated');
    if (!v) return;
    await call('add_tags', { ids, tags: v.split(',').map((t) => t.trim()).filter(Boolean) });
    refreshMeta();
  },
  async collect(anchor, ids) {
    const cols = await call('list_collections');
    popover(anchor, [
      ...cols.map((c) => ({ label: c.name, icon: 'layers', onClick: async () => { await call('add_to_collection', { collection: c.name, ids }); toast(`Added to ${c.name}`); refreshMeta(); } })),
      cols.length ? '-' : null,
      { label: 'New collection…', icon: 'plus', onClick: async () => {
        const name = await prompt('New collection', '', 'Collection name');
        if (name) { await call('add_to_collection', { collection: name, ids }); toast(`Added to ${name}`); refreshMeta(); }
      } },
    ].filter(Boolean));
  },
  async trash(ids, detail) {
    const r = await native('trash', { ids, detail });
    if (r.trashed) { toast(`Moved ${r.trashed} file${r.trashed > 1 ? 's' : ''} to the Recycle Bin`); S.sel.clear(); showDetail(null); reload(); }
    if (r.failed && r.failed.length) toast('Could not move: ' + r.failed.join(', '), 'error');
    return r;
  },
  async aiTag(ids) {
    if (!S.settings.ai || !S.settings.ai.visionModel) return toast('Pick a vision model in Settings → Local AI first.', 'error');
    const r = await call('ai_tag', { ids });
    toast(`AI tagging ${r.total} model${r.total === 1 ? '' : 's'}…`);
    pollAi();
  },
  view(file) {
    openViewer(file, { onSlicer: (e) => A.slicerMenu(e.currentTarget, [file.id]) });
  },
  go(view, scope) {
    S.view = view;
    if (scope) S.scope = scope;
    if (view !== 'library') showDetail(null);
    S.sel.clear();
    render();
  },
  openFolder(dir) { S.view = 'library'; S.scope = { type: 'all' }; S.filter.dir = dir; S.sel.clear(); render(); },
  filterTag(tag) { S.view = 'library'; if (!S.filter.tags.includes(tag)) S.filter.tags.push(tag); render(); },
};
export const ctx = { S, A, call, native, reload: () => reload(), refreshMeta: () => refreshMeta(), render: () => render() };

// ------------------------------------------------------------------ sidebar
function renderSidebar() {
  const st = S.stats;
  const nav = (id, label, ic, count, active, onClick) =>
    h('button', { class: 'nav-item' + (active ? ' active' : ''), onClick }, icon(ic), label, count ? h('span', { class: 'count' }, count.toLocaleString()) : null);
  const lib = S.view === 'library';
  const side = $('sidebar');
  const treeScroll = side.querySelector('.tree')?.scrollTop || 0;
  side.replaceChildren(
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('cube', 15)), 'Printshelf'),
    h('nav', { class: 'nav' },
      nav('all', 'All models', 'grid', st.models, lib && S.scope.type === 'all' && !S.filter.dir, () => { S.filter.dir = null; A.go('library', { type: 'all' }); }),
      nav('fav', 'Favorites', 'heart', st.favorites, lib && S.scope.type === 'favorites', () => { S.filter.dir = null; A.go('library', { type: 'favorites' }); }),
      nav('col', 'Collections', 'layers', st.collections, S.view === 'collections' || (lib && S.scope.type === 'collection'), () => A.go('collections')),
      nav('queue', 'Print queue', 'printer', st.queue, S.view === 'queue', () => A.go('queue')),
      nav('dupes', 'Duplicates', 'copy', 0, S.view === 'duplicates', () => A.go('duplicates')),
      nav('settings', 'Settings', 'settings', 0, S.view === 'settings', () => A.go('settings'))),
    h('div', { class: 'side-head' }, 'Sources', h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Rescan all sources', onClick: () => { call('rescan'); toast('Rescanning…'); } }, icon('refresh', 14)),
      h('button', { class: 'icon-btn', title: 'Add a folder', onClick: addSource }, icon('plus', 14))),
    h('div', { class: 'tree' }, S.sources.map((s) => treeNode({ name: s.name, path: s.path, source: s }))),
    statusBox());
  side.querySelector('.tree').scrollTop = treeScroll;
}

function treeNode(node) {
  const open = S.expanded.has(node.path);
  const kids = h('div', { class: 'tree-kids' });
  const twist = h('span', { class: 'twist' }, icon(open ? 'down' : 'right', 12));
  const row = h('div', {
    class: 'tree-row' + (S.view === 'library' && S.filter.dir === node.path ? ' active' : '') + (node.source && node.source.paused ? ' paused' : ''),
    title: node.path,
    onClick: () => A.openFolder(node.path),
    onContextmenu: (e) => { e.preventDefault(); if (node.source) sourceMenu(row, node.source); else popover(row, [{ label: 'Reveal in Explorer', icon: 'folder', onClick: () => native('reveal', { path: node.path }) }]); },
  }, twist, icon(node.archive ? 'archive' : 'folder', 14), h('span', { class: 'label' }, node.name),
    node.source ? h('button', { class: 'icon-btn', style: { width: '18px', height: '18px' }, onClick: (e) => { e.stopPropagation(); sourceMenu(e.currentTarget, node.source); } }, icon('list', 12)) : null);
  const load = async () => {
    const subs = await call('subdirs', { path: node.path });
    kids.replaceChildren(...subs.map(treeNode));
    if (!subs.length) twist.replaceChildren();
  };
  twist.addEventListener('click', (e) => {
    e.stopPropagation();
    if (S.expanded.has(node.path)) { S.expanded.delete(node.path); kids.replaceChildren(); twist.replaceChildren(icon('right', 12)); }
    else { S.expanded.add(node.path); twist.replaceChildren(icon('down', 12)); load(); }
    localStorage.expanded = JSON.stringify([...S.expanded].slice(-200));
  });
  if (open) load();
  return h('div', {}, row, kids);
}

function sourceMenu(anchor, s) {
  popover(anchor, [
    { label: 'Rescan', icon: 'refresh', onClick: () => call('rescan', { id: s.id }) },
    { label: s.paused ? 'Resume watching' : 'Pause', icon: s.paused ? 'play' : 'pause', onClick: async () => { await call('pause_source', { id: s.id, paused: !s.paused }); refreshMeta(); } },
    { label: 'Reveal in Explorer', icon: 'folder', onClick: () => native('reveal', { path: s.path }) },
    '-',
    { label: 'Remove from library', icon: 'x', danger: true, onClick: async () => {
      await call('remove_source', { id: s.id });
      toast(`Removed "${s.name}" from the library. The files on disk were not touched.`);
      if (S.filter.dir && S.filter.dir.startsWith(s.path)) S.filter.dir = null;
      refreshMeta(); reload();
    } },
  ]);
}

async function addSource() {
  const p = await native('pick_folder');
  if (!p) return;
  await call('add_source', { path: p });
  toast('Scanning ' + p);
  refreshMeta();
}

function statusBox() {
  const st = S.stats;
  const box = h('div', { class: 'status' });
  const pend = (st.pendingThumbs || 0);
  if (S.scan && S.scan.running) box.append(h('div', {}, `Scanning… ${S.scan.found || 0} files`), h('div', { class: 'bar' }, h('i', { style: { width: '40%' } })));
  else if (pend > 0) {
    const total = Math.max(st.files || 1, 1);
    box.append(h('div', {}, `Rendering thumbnails · ${pend.toLocaleString()} left`), h('div', { class: 'bar' }, h('i', { style: { width: Math.round(100 * (1 - pend / total)) + '%' } })));
  } else if (S.ai && S.ai.active) {
    box.append(h('div', {}, `AI tagging · ${S.ai.done}/${S.ai.total}`), h('div', { class: 'bar' }, h('i', { style: { width: Math.round((100 * S.ai.done) / Math.max(S.ai.total, 1)) + '%' } })));
  } else box.append(h('div', {}, `${(st.models || 0).toLocaleString()} models · ${fmtSize(st.bytes || 0)}`), h('div', { class: 'muted' }, 'Indexed in place. Nothing is moved.'));
  return box;
}

// ------------------------------------------------------------------ toolbar
function renderToolbar() {
  const bar = $('toolbar');
  if (S.view !== 'library') { bar.hidden = true; return; }
  bar.hidden = false;
  const f = S.filter;
  const had = document.activeElement && document.activeElement.id === 'q';
  const caret = had ? document.activeElement.selectionStart : 0;
  const search = h('input', { id: 'q', type: 'search', placeholder: S.semantic ? 'Describe what you are looking for…' : 'Search name, folder, tag, creator…  (Ctrl+F)', value: f.q,
    onInput: debounce((e) => { f.q = e.target.value; reload(); }, 220) });
  const seg = (opts, cur, set) => h('div', { class: 'seg' }, opts.map(([v, label, title]) => h('button', { class: cur === v ? 'on' : '', title, onClick: () => { set(v); render(); } }, label)));
  const exts = (S.stats.byExt || []).map((e) => e.ext);
  const fmtSel = h('select', { title: 'Format', onChange: (e) => { f.show = e.target.value; render(); } },
    h('option', { value: 'models' }, 'All models'), h('option', { value: 'all' }, 'Everything (with companions)'), h('option', { value: 'archives' }, 'Archives'),
    exts.map((x) => h('option', { value: x }, '.' + x)));
  fmtSel.value = f.show;
  const sortSel = h('select', { title: 'Sort', onChange: (e) => { f.sort = e.target.value; reload(); } },
    [['name', 'Name (A–Z)'], ['name_desc', 'Name (Z–A)'], ['newest', 'Newest file'], ['oldest', 'Oldest file'], ['added', 'Recently added'], ['largest', 'Largest'], ['smallest', 'Smallest']].map(([v, l]) => h('option', { value: v }, l)));
  sortSel.value = f.sort;
  const printSel = h('select', { title: 'Printed status', onChange: (e) => { f.printed = e.target.value; reload(); } },
    h('option', { value: '' }, 'Printed or not'), h('option', { value: 'yes' }, 'Printed'), h('option', { value: 'no' }, 'Not printed'));
  printSel.value = f.printed;

  const crumbs = h('div', { class: 'crumbs' });
  if (S.scope.type === 'favorites') crumbs.append(h('b', {}, 'Favorites'));
  else if (S.scope.type === 'collection') crumbs.append(h('a', { onClick: () => A.go('collections') }, 'Collections'), icon('right', 12), h('b', {}, S.scope.name));
  else if (!f.dir) crumbs.append(h('b', {}, 'All models'));
  if (f.dir) {
    const src = S.sources.find((s) => f.dir.toLowerCase().startsWith(s.path.toLowerCase()));
    const base = src ? src.path : '';
    const rest = f.dir.slice(base.length);
    const parts = rest.split(/(::|[\\/])/).filter((p) => p !== '');
    let acc = base;
    crumbs.append(h('a', { onClick: () => A.openFolder(base) }, src ? src.name : base));
    for (let i = 0; i < parts.length; i += 2) {
      acc += parts[i] + (parts[i + 1] || '');
      const p = acc;
      crumbs.append(icon('right', 12), i + 2 >= parts.length ? h('b', {}, parts[i + 1]) : h('a', { onClick: () => A.openFolder(p) }, parts[i + 1]));
    }
    crumbs.append(h('span', { class: 'chip' }, h('button', { title: 'Clear folder filter', onClick: () => { f.dir = null; render(); } }, icon('x', 11))));
  }
  for (const t of f.tags) crumbs.append(h('span', { class: 'chip accent' }, icon('tag', 11), t, h('button', { onClick: () => { f.tags = f.tags.filter((x) => x !== t); render(); } }, icon('x', 11))));
  crumbs.append(h('span', { class: 'grow' }), h('span', { id: 'count' }, ''));

  bar.replaceChildren(...[
    h('div', { class: 'search' }, icon('search', 15), search),
    h('button', { class: 'btn' + (S.semantic ? ' on' : ''), title: 'Search by what a model looks like, using your local embedding model', onClick: () => {
      if (!S.semantic && !(S.settings.ai && S.settings.ai.embedModel)) return toast('Pick an embedding model in Settings → Local AI to search by meaning.', 'error');
      S.semantic = !S.semantic; render();
    } }, icon('spark', 14), 'AI'),
    h('button', { class: 'btn' + (f.tags.length ? ' on' : ''), onClick: (e) => tagMenu(e.currentTarget) }, icon('tag', 14), 'Tags'),
    fmtSel, printSel, sortSel,
    f.dir ? h('button', { class: 'btn' + (f.flat ? ' on' : ''), title: 'Flat view shows everything beneath this folder', onClick: () => { f.flat = !f.flat; render(); } }, 'Flat view') : null,
    seg([['s', 'S', 'Small cards'], ['m', 'M', 'Medium cards'], ['l', 'L', 'Large cards']], S.cardSize, (v) => { S.cardSize = v; localStorage.cardSize = v; }),
    crumbs].filter(Boolean));
  if (had) { search.focus(); search.setSelectionRange(caret, caret); }
}

function tagMenu(anchor) {
  const list = h('div');
  const draw = (q) => {
    list.replaceChildren(...S.tags.filter((t) => !q || t.name.toLowerCase().includes(q)).slice(0, 200).map((t) =>
      h('button', { class: 'menu-item' + (S.filter.tags.includes(t.name) ? ' on' : ''), onClick: () => {
        const i = S.filter.tags.indexOf(t.name);
        if (i < 0) S.filter.tags.push(t.name); else S.filter.tags.splice(i, 1);
        render(); draw(q);
      } }, S.filter.tags.includes(t.name) ? icon('check', 13) : icon('tag', 13), t.name, h('span', { class: 'count' }, t.count))));
    if (!S.tags.length) list.append(h('div', { class: 'muted', style: { padding: '8px 10px' } }, 'No tags yet. Select models and add some, or run AI tagging.'));
  };
  const input = h('input', { class: 'input', placeholder: 'Filter tags…', onInput: (e) => draw(e.target.value.toLowerCase()) });
  draw('');
  popover(anchor, h('div', { style: { width: '240px' } }, input, list));
  input.focus();
}

// ------------------------------------------------------------------ grid
const grid = { scroll: null, inner: null, nodes: new Map(), cols: 1, cw: 0, ch: 0, gap: 12 };

function renderLibrary() {
  const content = $('content');
  grid.scroll = h('div', { class: 'grid-scroll', onScroll: () => requestAnimationFrame(drawVisible) });
  grid.inner = h('div', { class: 'grid-inner' });
  grid.scroll.append(grid.inner);
  grid.nodes.clear();
  content.replaceChildren(grid.scroll);
  grid.scroll.addEventListener('mousedown', (e) => { if (e.target === grid.scroll || e.target === grid.inner) { S.sel.clear(); updateSelection(); showDetail(null); } });
  new ResizeObserver(() => { layout(); drawVisible(true); }).observe(grid.scroll);
  reload();
}

let loadSeq = 0;
async function reload() {
  if (S.view !== 'library' || !grid.scroll) return;
  const seq = ++loadSeq;
  const f = S.filter;
  const filter = { q: f.q, show: f.show, dir: f.dir, flat: f.flat, tags: f.tags, sort: f.sort, printed: f.printed };
  if (S.scope.type === 'favorites') filter.favorite = true;
  if (S.scope.type === 'collection') filter.collection = S.scope.id;
  let items;
  if (S.semantic && f.q.trim()) {
    let hits = null;
    try { hits = await window.api.tool('semantic', { query: f.q, limit: 80 }); } catch (e) { toast('AI search failed: ' + e.message, 'error'); }
    if (seq !== loadSeq) return;
    if (hits && hits.length) {
      items = await call('list_files', { ...filter, q: '', ids: hits.map((x) => x.id) });
      const order = new Map(hits.map((x, i) => [x.id, i]));
      items.sort((a, b) => order.get(a.id) - order.get(b.id));
    }
  }
  if (!items) items = await call('list_files', filter);
  if (seq !== loadSeq) return;
  if (f.dir && !f.flat && !f.q) {
    const subs = await call('subdirs', { path: f.dir });
    items = [...subs.map((s) => ({ folder: true, id: 'd:' + s.path, name: s.name, path: s.path, archive: s.archive })), ...items];
  }
  S.items = items;
  const count = $('count');
  if (count) count.textContent = `${items.filter((i) => !i.folder).length.toLocaleString()} item${items.length === 1 ? '' : 's'}`;
  for (const n of grid.nodes.values()) n.remove();
  grid.nodes.clear();
  layout();
  drawVisible(true);
  const old = grid.scroll.querySelector('.empty');
  if (old) old.remove();
  if (!items.length) grid.scroll.append(emptyState());
}

function emptyState() {
  const filtered = S.filter.q || S.filter.tags.length || S.filter.dir || S.scope.type !== 'all' || S.filter.show !== 'models' || S.filter.printed;
  if (filtered) return h('div', { class: 'empty' }, icon('search', 36), h('h2', {}, 'Nothing matches'), h('p', {}, 'Try fewer filters or a different search.'));
  return h('div', { class: 'empty' }, icon('cube', 44), h('h2', {}, 'Your library is empty'),
    h('p', {}, 'Add the folders where your downloaded models live. They are indexed in place: nothing is renamed, moved or uploaded.'),
    h('button', { class: 'btn primary', onClick: addSource }, icon('plus', 14), 'Add a folder'));
}

function layout() {
  if (!grid.scroll) return;
  const width = grid.scroll.clientWidth - 28;
  const min = CARD_MIN[S.cardSize];
  grid.cols = Math.max(1, Math.floor((width + grid.gap) / (min + grid.gap)));
  grid.cw = Math.floor((width - grid.gap * (grid.cols - 1)) / grid.cols);
  grid.ch = grid.cw + 58;
  const rows = Math.ceil(S.items.length / grid.cols);
  grid.inner.style.height = Math.max(0, rows * (grid.ch + grid.gap) - grid.gap) + 'px';
}

const prioritize = debounce(() => {
  const ids = [];
  for (const [i] of grid.nodes) { const it = S.items[i]; if (it && !it.folder && it.thumb_state === 0) ids.push(it.id); }
  if (ids.length) window.api.tool('prioritize', { ids });
}, 250);

function drawVisible(force) {
  if (!grid.scroll || S.view !== 'library') return;
  const top = grid.scroll.scrollTop, hgt = grid.scroll.clientHeight, rowH = grid.ch + grid.gap;
  const first = Math.max(0, Math.floor(top / rowH) - 2) * grid.cols;
  const last = Math.min(S.items.length, (Math.ceil((top + hgt) / rowH) + 2) * grid.cols);
  for (const [i, n] of grid.nodes) if (force || i < first || i >= last) { n.remove(); grid.nodes.delete(i); }
  for (let i = first; i < last; i++) {
    if (grid.nodes.has(i)) continue;
    const n = card(S.items[i], i);
    n.style.left = (i % grid.cols) * (grid.cw + grid.gap) + 'px';
    n.style.top = Math.floor(i / grid.cols) * rowH + 'px';
    n.style.width = grid.cw + 'px';
    n.style.height = grid.ch + 'px';
    grid.inner.append(n);
    grid.nodes.set(i, n);
  }
  prioritize();
}

function thumbNode(f, size = 34) {
  if (f.thumb_state === 1) return h('img', { src: thumbUrl(f), loading: 'lazy', draggable: false });
  if (f.thumb_state === 0) return h('div', { class: 'spin' });
  const ic = f.kind === 'archive' ? 'archive' : f.kind === 'image' ? 'image' : f.kind === 'doc' || f.kind === 'video' ? 'file' : 'cube';
  return h('div', { class: 'ph' }, icon(ic, size));
}

function card(f, i) {
  if (f.folder) {
    return h('div', { class: 'card folder', title: f.path, onDblclick: () => A.openFolder(f.path), onClick: () => A.openFolder(f.path) },
      h('div', { class: 'thumb' }, icon(f.archive ? 'archive' : 'folder', 44)),
      h('div', { class: 'meta' }, h('div', { class: 'name' }, f.name), h('div', { class: 'sub' }, f.archive ? 'Archive' : 'Folder')));
  }
  const tags = f.tags ? f.tags.split('|') : [];
  const shown = tags.slice(0, S.cardSize === 's' ? 0 : 1);
  const el = h('div', {
    class: 'card' + (S.sel.has(f.id) ? ' sel' : ''), draggable: true, title: f.path, dataset: { id: f.id },
    onClick: (e) => select(i, e),
    onDblclick: () => A.view(f),
    onContextmenu: (e) => { e.preventDefault(); if (!S.sel.has(f.id)) select(i, {}); cardMenu(e, f); },
    onDragstart: (e) => { e.preventDefault(); window.api.drag(S.sel.has(f.id) ? [...S.sel] : [f.id]); },
  },
    h('div', { class: 'thumb' }, thumbNode(f),
      h('span', { class: 'badge' }, f.ext),
      f.printed ? h('span', { class: 'printed', title: 'Printed' }, icon('check', 12)) : null,
      f.archive_id ? h('span', { class: 'inzip', title: 'Inside an archive' }, icon('archive', 13)) : null,
      h('button', { class: 'fav' + (f.favorite ? ' on' : ''), title: 'Favorite', onClick: async (e) => { e.stopPropagation(); f.favorite = f.favorite ? 0 : 1; e.currentTarget.classList.toggle('on', !!f.favorite); await A.favorite([f.id], !!f.favorite); refreshMeta(); } }, icon('heart', 14))),
    h('div', { class: 'meta' },
      h('div', { class: 'name' }, f.name.replace(/\.[^.]+$/, '')),
      h('div', { class: 'sub' }, h('span', { class: 'size' }, fmtSize(f.size)),
        shown.map((t) => h('span', { class: 'chip' + (t === 'Multi-color' ? ' violet' : '') }, t)),
        tags.length > shown.length ? h('span', { class: 'chip' }, '+' + (tags.length - shown.length)) : null)));
  return el;
}

function select(i, e) {
  const f = S.items[i];
  if (!f || f.folder) return;
  if (e.shiftKey && S.anchor >= 0) {
    const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)];
    if (!e.ctrlKey) S.sel.clear();
    for (let k = a; k <= b; k++) if (!S.items[k].folder) S.sel.add(S.items[k].id);
  } else if (e.ctrlKey || e.metaKey) {
    if (S.sel.has(f.id)) S.sel.delete(f.id); else S.sel.add(f.id);
    S.anchor = i;
  } else { S.sel.clear(); S.sel.add(f.id); S.anchor = i; }
  updateSelection();
  showDetail(S.sel.size === 1 ? [...S.sel][0] : null);
}

function updateSelection() {
  for (const [i, n] of grid.nodes) { const it = S.items[i]; if (it) n.classList.toggle('sel', S.sel.has(it.id)); }
  const old = document.querySelector('.bulk');
  if (old) old.remove();
  if (S.sel.size > 1 && S.view === 'library') {
    const ids = [...S.sel];
    $('content').append(h('div', { class: 'bulk' },
      h('b', {}, `${ids.length} selected`),
      h('button', { class: 'btn small', onClick: () => A.addTags(ids) }, icon('tag', 13), 'Tag'),
      h('button', { class: 'btn small', onClick: (e) => A.collect(e.currentTarget, ids) }, icon('layers', 13), 'Collect'),
      h('button', { class: 'btn small', onClick: () => A.queue(ids) }, icon('printer', 13), 'Queue'),
      h('button', { class: 'btn small', onClick: () => A.favorite(ids, true).then(refreshMeta) }, icon('heart', 13), 'Favorite'),
      h('button', { class: 'btn small', onClick: (e) => A.slicerMenu(e.currentTarget, ids) }, icon('external', 13), 'Slicer'),
      h('button', { class: 'btn small', onClick: () => A.aiTag(ids) }, icon('spark', 13), 'AI tag'),
      h('button', { class: 'btn small danger', onClick: () => A.trash(ids) }, icon('trash', 13)),
      h('button', { class: 'icon-btn', title: 'Clear selection', onClick: () => { S.sel.clear(); updateSelection(); } }, icon('x', 14))));
  }
}

function cardMenu(e, f) {
  const ids = S.sel.size > 1 && S.sel.has(f.id) ? [...S.sel] : [f.id];
  const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
  popover(anchor, [
    ids.length === 1 ? { label: 'Open in viewer', icon: 'eye', onClick: () => A.view(f) } : null,
    ...S.slicers.slice(0, 6).map((s) => ({ label: 'Open in ' + s.name, icon: 'external', onClick: () => A.openSlicer(ids, s.name) })),
    { label: 'Reveal in Explorer', icon: 'folder', onClick: () => native('reveal', { id: f.id }) },
    '-',
    { label: 'Add tags…', icon: 'tag', onClick: () => A.addTags(ids) },
    { label: 'Add to collection…', icon: 'layers', onClick: () => A.collect(anchor, ids) },
    { label: 'Add to print queue', icon: 'printer', onClick: () => A.queue(ids) },
    { label: f.printed ? 'Mark as not printed' : 'Mark as printed', icon: 'check', onClick: () => A.printed(ids, !f.printed) },
    { label: 'Describe and tag with AI', icon: 'spark', onClick: () => A.aiTag(ids) },
    S.scope.type === 'collection' ? { label: 'Remove from this collection', icon: 'x', onClick: async () => { await call('remove_from_collection', { collection: S.scope.name, ids }); reload(); refreshMeta(); } } : null,
    '-',
    { label: 'Move to Recycle Bin', icon: 'trash', danger: true, onClick: () => A.trash(ids) },
  ].filter(Boolean));
}

// ------------------------------------------------------------------ detail
let detailId = null;
async function showDetail(id) {
  detailId = id;
  const el = $('detail');
  if (!id) { el.hidden = true; el.replaceChildren(); return; }
  const f = await call('get_file', { id });
  if (detailId !== id) return;
  if (!f) { el.hidden = true; return; }
  el.hidden = false;
  renderDetail(el, f, ctx, () => { S.sel.clear(); updateSelection(); showDetail(null); });
}

// ------------------------------------------------------------------ shell
function render() {
  renderSidebar();
  renderToolbar();
  if (S.view === 'library') renderLibrary();
  else { grid.scroll = null; pages[S.view]($('content'), ctx); }
  updateSelection();
}

async function refreshMeta() {
  [S.stats, S.sources, S.tags] = await Promise.all([call('library_stats'), call('sources'), call('list_tags')]);
  S.tags = S.tags.map((t) => ({ ...t }));
  renderSidebar();
}

const softReload = debounce(async () => {
  await refreshMeta();
  if (S.view === 'library') {
    const top = grid.scroll ? grid.scroll.scrollTop : 0;
    await reload();
    if (grid.scroll) grid.scroll.scrollTop = top;
    updateSelection();
  }
  if (detailId && !document.activeElement.closest?.('#detail')) showDetail(detailId);
  if (S.view === 'queue' || S.view === 'collections') pages[S.view]($('content'), ctx);
}, 500);

let aiTimer = null;
async function pollAi() {
  clearTimeout(aiTimer);
  const s = await window.api.tool('ai_status').catch(() => null);
  if (!s) return;
  const was = S.ai && S.ai.active;
  S.ai = s.run;
  renderSidebar();
  if (s.run.active) aiTimer = setTimeout(pollAi, 1500);
  else if (was) {
    toast(s.run.errors ? `AI tagging finished with ${s.run.errors} error(s): ${s.run.lastError}` : `AI tagging finished: ${s.run.done} models`, s.run.errors ? 'error' : '');
    softReload();
  }
}
ctx.pollAi = pollAi;

window.api.on('files-updated', () => softReload());
window.api.on('scan', (p) => { S.scan = p; if (p.error) toast(p.error, 'error'); renderSidebar(); });
window.api.on('imported', (r) => { toast(r.error ? 'Import failed: ' + r.error : `Imported "${r.title || 'model'}" from your inbox folder`, r.error ? 'error' : ''); softReload(); });

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); if (isViewerOpen()) closeViewer(); if (S.view !== 'library') A.go('library'); $('q')?.focus(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.modal-back')) return;
    if (document.querySelector('.popover')) return document.querySelectorAll('.popover').forEach((p) => p.remove());
    if (isViewerOpen()) return closeViewer();
    if (typing) return document.activeElement.blur();
    if (S.sel.size) { S.sel.clear(); updateSelection(); showDetail(null); }
    return;
  }
  if (typing || isViewerOpen() || S.view !== 'library') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); S.sel = new Set(S.items.filter((i) => !i.folder).map((i) => i.id)); updateSelection(); showDetail(null); }
  else if (e.key === 'Delete' && S.sel.size) A.trash([...S.sel]);
  else if (e.key === 'Enter' && S.sel.size === 1) { const f = S.items.find((i) => i.id === [...S.sel][0]); if (f) A.view(f); }
  else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key) && S.items.length) {
    e.preventDefault();
    const cur = S.anchor < 0 ? -1 : S.anchor;
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: grid.cols, ArrowUp: -grid.cols }[e.key];
    const next = Math.max(0, Math.min(S.items.length - 1, cur < 0 ? 0 : cur + d));
    if (S.items[next].folder) return;
    select(next, {});
    const rowTop = Math.floor(next / grid.cols) * (grid.ch + grid.gap);
    if (rowTop < grid.scroll.scrollTop) grid.scroll.scrollTop = rowTop;
    else if (rowTop + grid.ch > grid.scroll.scrollTop + grid.scroll.clientHeight - 28) grid.scroll.scrollTop = rowTop + grid.ch - grid.scroll.clientHeight + 40;
  }
});

// drop a folder to add it as a source, or files to copy them into the library
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; $('dropzone').hidden = false; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  let folders = 0, files = 0;
  for (const item of e.dataTransfer.files) {
    const p = window.api.pathOf(item);
    if (!p) continue;
    try {
      try { await window.api.tool('add_source', { path: p }); folders++; }
      catch (notFolder) {
        if (!/Not a folder/.test(notFolder.message)) throw notFolder;
        await window.api.tool('import_file', { path: p }); files++;
      }
    } catch (err) { toast(`${item.name}: ${String(err.message).replace(/^.*Error: /, '')}`, 'error'); }
  }
  if (folders) toast(`Added ${folders} folder${folders > 1 ? 's' : ''} as a source`);
  if (files) toast(`Copied ${files} file${files > 1 ? 's' : ''} into your library`);
  refreshMeta();
});

(async function start() {
  [S.settings, S.slicers] = await Promise.all([call('get_settings'), call('slicers')]);
  await refreshMeta();
  render();
  pollAi();
})();
