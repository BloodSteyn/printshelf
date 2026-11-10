// Collections, print queue, duplicates and settings pages.
import { h, icon, fmtSize, fmtDuration, toast, thumbUrl, prompt, popover } from './ui.js';

const img = (f, cls) => (f.thumb_state === 1 ? h('img', { src: thumbUrl(f), class: cls || '' }) : h('div', { class: 'noimg' }, icon('cube', 20)));

// ------------------------------------------------------------------ collections
async function collections(root, ctx) {
  const { call, A } = ctx;
  const list = await call('list_collections');
  const page = h('div', { class: 'page' },
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Collections'),
      h('button', { class: 'btn primary', onClick: async () => {
        const name = await prompt('New collection', '', 'e.g. Christmas gifts');
        if (name) { await call('add_to_collection', { collection: name, ids: [] }); ctx.refreshMeta(); collections(root, ctx); }
      } }, icon('plus', 14), 'New collection')),
    h('p', { class: 'lead' }, 'Group models across folders without moving a single file. Select models in the library and choose Collect.'),
    list.length ? h('div', { class: 'coll-grid' }, list.map((c) => h('div', { class: 'coll', onClick: () => A.go('library', { type: 'collection', id: c.id, name: c.name }) },
      h('div', { class: 'cover' }, c.cover ? h('img', { src: `/thumb/${c.cover}` }) : icon('layers', 36)),
      h('div', { class: 'cap' }, h('b', {}, c.name), h('span', { class: 'muted' }, c.count),
        h('button', { class: 'icon-btn', onClick: (e) => { e.stopPropagation(); popover(e.currentTarget, [
          { label: 'Rename…', icon: 'tag', onClick: async () => { const n = await prompt('Rename collection', c.name); if (n) { await call('rename_collection', { id: c.id, name: n }); collections(root, ctx); } } },
          { label: 'Delete collection', icon: 'trash', danger: true, onClick: async () => { await call('delete_collection', { id: c.id }); toast('Collection deleted. Its models stay in the library.'); ctx.refreshMeta(); collections(root, ctx); } },
        ]); } }, icon('list', 13))))))
      : h('div', { class: 'empty' }, icon('layers', 40), h('h2', {}, 'No collections yet'), h('p', {}, 'A collection is a named set of models, like "To print for Sam" or "Functional prints".')));
  root.replaceChildren(page);
}

// ------------------------------------------------------------------ print queue
async function queue(root, ctx) {
  const { call, A } = ctx;
  const rows = await call('print_queue_list');
  const upd = async (entry_id, patch) => { await call('print_queue_update', { entry_id, ...patch }); ctx.refreshMeta(); queue(root, ctx); };
  const open = rows.filter((r) => r.status !== 'done');
  const time = open.reduce((a, r) => a + (r.meta.printSeconds || 0) * r.qty, 0);
  const grams = open.reduce((a, r) => a + (r.meta.filamentGrams || 0) * r.qty, 0);
  const page = h('div', { class: 'page' },
    h('h1', {}, 'Print queue'),
    h('p', { class: 'lead' }, open.length ? `${open.length} waiting` + (time ? ` · about ${fmtDuration(time)} of sliced print time` : '') + (grams ? ` · ${grams.toFixed(0)} g of filament` : '') : 'Line up what you want to print next. Marking an entry done also marks the model as printed.'),
    rows.length ? h('table', { class: 'q' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Model'), h('th', {}, 'Qty'), h('th', {}, 'Note'), h('th', {}, 'Status'), h('th', {}, ''))),
      h('tbody', {}, rows.map((r) => h('tr', { class: r.status === 'done' ? 'done' : '' },
        h('td', {}, img({ id: r.file_id, thumb_state: r.thumb_state, thumb_ver: r.thumb_ver })),
        h('td', {}, h('div', { style: { fontWeight: 550 } }, r.name), h('div', { class: 'muted', style: { fontSize: '11.5px' } }, [r.meta.printer, r.meta.nozzle && r.meta.nozzle + ' mm', r.meta.printSeconds && fmtDuration(r.meta.printSeconds)].filter(Boolean).join(' · '))),
        h('td', {}, h('input', { class: 'input', type: 'number', min: 1, value: r.qty, onChange: (e) => upd(r.entry_id, { qty: Number(e.target.value) }) })),
        h('td', {}, h('input', { class: 'input', value: r.note || '', placeholder: 'Colour, material, who it is for…', style: { width: '100%' }, onChange: (e) => upd(r.entry_id, { note: e.target.value }) })),
        h('td', {}, (() => { const s = h('select', { onChange: (e) => upd(r.entry_id, { status: e.target.value }) }, ['queued', 'printing', 'done'].map((v) => h('option', { value: v }, v[0].toUpperCase() + v.slice(1)))); s.value = r.status; return s; })()),
        h('td', {}, h('div', { class: 'row end' },
          h('button', { class: 'btn small', onClick: (e) => A.slicerMenu(e.currentTarget, [r.file_id]) }, icon('external', 12), 'Slicer'),
          h('button', { class: 'icon-btn', title: 'Remove from queue', onClick: () => upd(r.entry_id, { remove: true }) }, icon('x', 14))))))))
      : h('div', { class: 'empty' }, icon('printer', 40), h('h2', {}, 'Nothing queued'), h('p', {}, 'Right-click a model and choose "Add to print queue".')));
  root.replaceChildren(page);
}

// ------------------------------------------------------------------ duplicates
let dupeKeys = null;
async function duplicates(root, ctx) {
  const { call, native, A } = ctx;
  root.replaceChildren(h('div', { class: 'page' }, h('div', { class: 'row' }, h('div', { class: 'spin' }), 'Comparing files…')));
  const d = await call('duplicates');
  const st = ctx.S.stats;
  const redo = () => duplicates(root, ctx);
  const reclaim = d.certain.reduce((a, g) => a + g.reclaim, 0);
  const keepers = new Map(d.certain.map((g) => [g, g.keep]));

  const memberRow = (g, m) => {
    const isKeep = () => keepers.get(g) === m.id;
    const pill = h('span', { class: 'pill ' + (isKeep() ? 'keep' : 'ok') }, isKeep() ? 'Keep' : m.match === 'Keep' ? 'Exact copy' : m.match);
    return h('div', { class: 'mrow' }, img(m),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'n' }, m.name), h('div', { class: 'p', title: m.path }, '‎' + m.path)),
      h('span', { class: 'muted' }, fmtSize(m.size)),
      h('div', { class: 'row' }, pill,
        h('button', { class: 'btn small', title: 'Keep this copy instead', onClick: () => { keepers.set(g, m.id); redraw(); } }, 'Keep this'),
        h('button', { class: 'icon-btn', title: 'Reveal', onClick: () => native('reveal', { id: m.id }) }, icon('folder', 13))));
  };
  const certainBox = h('div');
  const redraw = () => certainBox.replaceChildren(...d.certain.slice(0, 150).map((g) => h('div', { class: 'panel ok' },
    h('div', { class: 'row', style: { marginBottom: '6px' } },
      h('span', { class: 'muted grow' }, keepers.get(g) === g.keep ? `Suggested keeper chosen because ${g.reason}.` : 'You chose the keeper.'),
      h('span', { class: 'muted' }, `frees ${fmtSize(g.members.filter((m) => m.id !== keepers.get(g)).reduce((a, m) => a + m.size, 0))}`),
      h('button', { class: 'btn small danger', onClick: async () => {
        const r = await A.trash(g.members.filter((m) => m.id !== keepers.get(g)).map((m) => m.id), 'One copy stays: ' + g.members.find((m) => m.id === keepers.get(g)).path);
        if (r.trashed) redo();
      } }, icon('trash', 12), 'Remove the others')),
    g.members.map((m) => memberRow(g, m)))));
  redraw();

  const pairCard = (p) => h('div', { class: 'panel wait', dataset: { pair: p.pair } },
    h('div', { class: 'row' }, h('span', { class: 'pill wait' }, 'Likely duplicate'), h('span', { class: 'chip' }, p.badge), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onClick: () => decide(p, 'same') }, 'Same model (C)'),
      h('button', { class: 'btn small', onClick: () => decide(p, 'different') }, 'Different (N)')),
    h('div', { class: 'pair' }, p.members.map((m) => h('div', { class: 'side', title: 'Open in viewer', onClick: () => A.view(m) },
      m.thumb_state === 1 ? h('img', { src: thumbUrl(m) }) : h('div', { class: 'noimg', style: { width: '100%', height: '120px' } }, icon('cube', 30)),
      h('div', { class: 'n', style: { fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, m.name),
      h('div', { class: 'muted', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, m.path),
      h('div', { class: 'muted', style: { fontSize: '11.5px' } }, `${fmtSize(m.size)}${m.tri_count ? ' · ' + m.tri_count.toLocaleString() + ' triangles' : ''}`)))));
  const decide = async (p, decision) => { await call('dupe_decide', { pair: p.pair, decision }); redo(); };
  dupeKeys = (e) => {
    if (ctx.S.view !== 'duplicates' || !d.likely.length || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key.toLowerCase() === 'c') decide(d.likely[0], 'same');
    if (e.key.toLowerCase() === 'n') decide(d.likely[0], 'different');
  };

  const pending = (st.pendingHash || 0) + (st.pendingThumbs || 0);
  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'row' }, h('h1', { class: 'grow' }, 'Duplicates'), h('button', { class: 'btn', onClick: redo }, icon('refresh', 14), 'Check again')),
    h('p', { class: 'lead' }, 'Checks run from cheapest to smartest: same bytes, same mesh in another format, same shape rotated, rescaled or re-meshed, then archives you already unpacked and whole folders. Certain matches can be cleaned in one go; likely ones always wait for you. Files go to the Recycle Bin, and one copy always stays.'),
    pending ? h('div', { class: 'panel wait' }, `Still analysing ${pending.toLocaleString()} file(s). Results will grow as hashing and mesh measuring finish.`) : null,
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, d.certain.length), h('span', {}, 'certain groups')),
      h('div', { class: 'stat' }, h('b', {}, fmtSize(reclaim)), h('span', {}, 'can be freed')),
      h('div', { class: 'stat' }, h('b', {}, d.likely.length), h('span', {}, 'likely pairs to review')),
      h('div', { class: 'stat' }, h('b', {}, d.archives.length), h('span', {}, 'archives already unpacked')),
      h('div', { class: 'stat' }, h('b', {}, d.folders.length), h('span', {}, 'folder matches'))),

    h('h2', {}, h('span', { class: 'pill ok' }, 'Certain'), 'Exact copies and identical geometry', h('span', { class: 'grow' }),
      d.certain.length ? h('button', { class: 'btn small danger', onClick: async () => {
        // Bulk cleaning only takes byte-identical copies. The same mesh saved as a
        // different project can carry different print settings, so those stay per group.
        const ids = d.certain.filter((g) => keepers.get(g) === g.keep).flatMap((g) => g.members.filter((m) => m.match === 'Exact copy').map((m) => m.id));
        if (!ids.length) return toast('No byte-identical copies to clean. Review the groups below one by one.');
        const r = await A.trash(ids, 'Only byte-identical copies are removed. The keeper in every group stays.');
        if (r.trashed) redo();
      } }, icon('trash', 12), 'Clean all exact copies') : null),
    d.certain.length ? certainBox : h('p', { class: 'muted' }, 'No certain duplicates found.'),

    h('h2', {}, h('span', { class: 'pill wait' }, 'Needs your review'), 'Likely duplicates'),
    d.likely.length ? d.likely.slice(0, 60).map(pairCard) : h('p', { class: 'muted' }, 'Nothing waiting for review.'),

    h('h2', {}, 'Archives you already unpacked'),
    d.archives.length ? d.archives.map((a) => h('div', { class: 'panel ok' }, h('div', { class: 'row' }, icon('archive', 16),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { style: { fontWeight: 550 } }, a.archive.name, h('span', { class: 'muted' }, `  ·  ${fmtSize(a.archive.size)}  ·  ${a.matched} of ${a.total} files also exist unpacked`)),
        h('div', { class: 'muted', style: { fontSize: '11.5px', wordBreak: 'break-all' } }, 'Unpacked in ' + a.folder)),
      h('button', { class: 'btn small', onClick: () => native('reveal', { path: a.folder }) }, 'Open folder'),
      h('button', { class: 'btn small', onClick: () => native('reveal', { id: a.archive.id }) }, 'Show archive'),
      h('button', { class: 'btn small danger', onClick: async () => { const r = await A.trash([a.archive.id], 'The unpacked copy stays in ' + a.folder); if (r.trashed) redo(); } }, icon('trash', 12), 'Remove archive'))))
      : h('p', { class: 'muted' }, 'No archive matches an unpacked folder.'),

    h('h2', {}, 'Folders'),
    d.folders.length ? d.folders.map((g) => h('div', { class: 'panel ' + (g.kind === 'Folder overlap' ? 'wait' : 'ok') },
      h('div', { class: 'row', style: { marginBottom: '6px' } }, h('span', { class: 'pill ' + (g.kind === 'Folder overlap' ? 'wait' : 'ok') }, g.kind),
        h('span', { class: 'muted' }, g.kind === 'Folder overlap' ? 'Everything in the first folder also exists in the second.' : 'These folders hold the same files.')),
      g.folders.map((fo) => h('div', { class: 'row', style: { padding: '3px 0' } }, icon('folder', 14),
        h('span', { class: 'grow', style: { wordBreak: 'break-all', userSelect: 'text' } }, fo.path), h('span', { class: 'muted' }, `${fo.files} files · ${fmtSize(fo.bytes)}`),
        h('button', { class: 'btn small', onClick: () => A.openFolder(fo.path) }, 'Browse'),
        h('button', { class: 'btn small', onClick: () => native('reveal', { path: fo.path }) }, 'Reveal')))))
      : h('p', { class: 'muted' }, 'No duplicate folders found.')));
}
document.addEventListener('keydown', (e) => { if (dupeKeys) dupeKeys(e); });

// ------------------------------------------------------------------ settings
async function settings(root, ctx) {
  const { call, native, S } = ctx;
  const [s, ai, slicers, mcp, pending, sources] = await Promise.all([
    call('get_settings'), window.api.tool('ai_status'), call('slicers'), native('mcp_info'), call('list_pending_imports'), call('sources')]);
  S.settings = s; S.slicers = slicers;
  const redo = () => settings(root, ctx);
  const save = async (patch) => { S.settings = await call('save_settings', patch); toast('Saved'); redo(); };
  const folderRow = (label, key, hint) => [
    h('label', {}, label),
    h('div', { class: 'row' }, h('input', { class: 'input grow', value: s[key], readOnly: true }),
      h('button', { class: 'btn', onClick: async () => { const p = await native('pick_folder'); if (p) save({ [key]: p }); } }, 'Change…')),
    h('div', { class: 'hint' }, hint)];

  const modelSelect = (key, emptyLabel) => {
    const sel = h('select', { onChange: (e) => save({ ai: { [key]: e.target.value } }) },
      h('option', { value: '' }, emptyLabel), [...new Set([s.ai[key], ...ai.models].filter(Boolean))].map((m) => h('option', { value: m }, m)));
    sel.value = s.ai[key] || '';
    return sel;
  };
  const provider = h('select', { onChange: (e) => save({ ai: { provider: e.target.value, baseUrl: e.target.value === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1', visionModel: '', embedModel: '' } }) },
    h('option', { value: 'ollama' }, 'Ollama'), h('option', { value: 'openai' }, 'OpenAI-compatible (LM Studio, llama.cpp, vLLM, Hermes endpoint…)'));
  provider.value = s.ai.provider;

  const serverPath = mcp.server.replace(/\\/g, '\\\\');
  root.replaceChildren(h('div', { class: 'page' },
    h('h1', {}, 'Settings'),
    h('p', { class: 'lead' }, 'Everything stays on this computer. The library database lives in ', h('code', {}, mcp.dataDir), '.'),

    h('h2', {}, 'Sources'),
    h('div', { class: 'panel' },
      sources.map((src) => h('div', { class: 'row', style: { padding: '4px 0' } }, icon('folder', 14), h('span', { class: 'grow', style: { userSelect: 'text', wordBreak: 'break-all' } }, src.path),
        h('span', { class: 'muted' }, `${src.count.toLocaleString()} files${src.paused ? ' · paused' : ''}`),
        h('button', { class: 'btn small', onClick: () => call('rescan', { id: src.id }) }, 'Rescan'),
        h('button', { class: 'btn small', onClick: async () => { await call('pause_source', { id: src.id, paused: !src.paused }); ctx.refreshMeta(); redo(); } }, src.paused ? 'Resume' : 'Pause'),
        h('button', { class: 'btn small danger', onClick: async () => { await call('remove_source', { id: src.id }); ctx.refreshMeta(); redo(); } }, 'Remove'))),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn', onClick: async () => { const p = await native('pick_folder'); if (p) { await call('add_source', { path: p }); ctx.refreshMeta(); redo(); } } }, icon('plus', 14), 'Add a folder'),
        h('span', { class: 'muted' }, 'Removing a source only forgets it here. Files on disk are never touched by a scan.'))),

    h('h2', {}, 'Importing'),
    h('div', { class: 'panel' }, h('div', { class: 'form' },
      folderRow('Import folder', 'importDir', 'Models fetched by URL or handed over by an agent are stored here, in a folder per site and model. Make sure it is inside one of your sources.'),
      folderRow('Inbox folder', 'inboxDir', 'Where your browser saves downloads. A file is only picked up from here while an import is waiting for it.'),
      h('label', {}, 'Wait for a download'),
      h('div', { class: 'row' }, h('input', { class: 'input', type: 'number', min: 1, max: 120, value: s.inboxWindowMin, style: { width: '80px' }, onChange: (e) => save({ inboxWindowMin: Math.max(1, Number(e.target.value) || 15) }) }), 'minutes')),
      pending.filter((p) => p.status === 'waiting').length ? h('div', { style: { marginTop: '12px' } }, h('div', { class: 'muted', style: { marginBottom: '4px' } }, 'Waiting for a browser download:'),
        pending.filter((p) => p.status === 'waiting').map((p) => h('div', { class: 'row' }, icon('download', 14), h('span', { class: 'grow', style: { wordBreak: 'break-all' } }, p.meta.title || p.url),
          h('button', { class: 'btn small', onClick: async () => { await call('cancel_pending', { id: p.id }); redo(); } }, 'Cancel')))) : null),

    h('h2', {}, 'Local AI'),
    h('div', { class: 'panel' },
      h('div', { class: 'row', style: { marginBottom: '12px' } },
        h('span', { class: 'pill ' + (ai.ok ? 'ok' : 'wait') }, ai.ok ? `Connected · ${ai.models.length} models` : 'Not reachable'),
        ai.ok ? null : h('span', { class: 'muted' }, ai.error || ''),
        h('span', { class: 'grow' }), h('button', { class: 'btn small', onClick: redo }, icon('refresh', 12), 'Test again')),
      h('div', { class: 'form' },
        h('label', {}, 'Provider'), provider,
        h('label', {}, 'Server address'), h('input', { class: 'input', value: s.ai.baseUrl, onChange: (e) => save({ ai: { baseUrl: e.target.value.trim() } }) }),
        h('label', {}, 'API key'), h('input', { class: 'input', type: 'password', value: s.ai.apiKey, placeholder: 'Only if your endpoint needs one', onChange: (e) => save({ ai: { apiKey: e.target.value } }) }),
        h('label', {}, 'Vision model'), modelSelect('visionModel', 'Choose a model that can see images…'),
        h('div', { class: 'hint' }, 'Looks at each thumbnail and proposes a description and tags. Needs a vision-capable model such as gemma, llava, qwen-vl or minicpm-v.'),
        h('label', {}, 'Embedding model'), modelSelect('embedModel', 'Optional: for search by meaning…'),
        h('div', { class: 'hint' }, 'Powers the AI search toggle. With Ollama: ', h('code', {}, 'ollama pull nomic-embed-text'), '. Models tagged before you set this need re-tagging to become searchable by meaning.')),
      h('div', { class: 'row', style: { marginTop: '14px' } },
        h('button', { class: 'btn primary', disabled: !s.ai.visionModel, onClick: async () => { const r = await call('ai_tag', {}); toast(r.total ? `AI tagging ${r.total} models in the background` : 'Every model with a thumbnail is already tagged'); ctx.pollAi(); } }, icon('spark', 14), 'Tag all untagged models'),
        h('button', { class: 'btn', onClick: async () => { await call('ai_cancel'); toast('Stopping after the current model'); } }, 'Stop'))),

    h('h2', {}, 'Slicers'),
    h('div', { class: 'panel' },
      slicers.length ? slicers.map((sl) => h('div', { class: 'row', style: { padding: '3px 0' } }, icon('external', 14), h('b', {}, sl.name), h('span', { class: 'muted grow', style: { wordBreak: 'break-all' } }, sl.exe),
        h('button', { class: 'btn small' + (s.defaultSlicer === sl.name ? ' on' : ''), onClick: () => save({ defaultSlicer: sl.name }) }, s.defaultSlicer === sl.name ? 'Default' : 'Make default')))
        : h('div', { class: 'muted' }, 'No slicer was found in the usual install locations.'),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn', onClick: async () => {
        const exe = await native('pick_exe');
        if (!exe) return;
        const name = await prompt('Name for this program', exe.split(/[\\/]/).pop().replace(/\.exe$/i, ''));
        if (name) save({ slicerPaths: { ...s.slicerPaths, [name]: exe } });
      } }, icon('plus', 14), 'Add a slicer or other program…'))),

    h('h2', {}, 'Agents (MCP)'),
    h('div', { class: 'panel' },
      h('p', { style: { marginTop: 0 } }, 'Agents such as Claude can search, tag, organise and import into this library while the app is open. They cannot delete or move your existing files.'),
      h('div', { class: 'muted' }, 'Claude Code:'),
      h('pre', { class: 'code' }, `claude mcp add printshelf -- node "${mcp.server}"`),
      h('div', { class: 'muted' }, 'Claude Desktop and other clients (add to the MCP servers config):'),
      h('pre', { class: 'code' }, `"printshelf": { "command": "node", "args": ["${serverPath}"] }`)),

    h('h2', {}, 'Maintenance'),
    h('div', { class: 'panel' }, h('div', { class: 'form' },
      h('label', {}, 'Largest mesh to parse'),
      h('div', { class: 'row' }, h('input', { class: 'input', type: 'number', min: 10, value: s.maxMeshMB, style: { width: '90px' }, onChange: (e) => save({ maxMeshMB: Math.max(10, Number(e.target.value) || 250) }) }), 'MB. Bigger files keep an embedded preview if they have one.'),
      h('label', {}, 'Filament density'),
      h('div', { class: 'row' }, h('input', { class: 'input', type: 'number', step: '0.01', value: s.density, style: { width: '90px' }, onChange: (e) => save({ density: Number(e.target.value) || 1.24 }) }), 'g/cm³, used for the solid-weight estimate (PLA is 1.24).'),
      h('label', {}, 'Thumbnails'),
      h('div', { class: 'row' }, h('button', { class: 'btn', onClick: async () => { await call('retry_thumbs'); toast('Retrying failed previews'); } }, 'Retry failed previews'))))));
}

export const pages = { collections, queue, duplicates, settings };
