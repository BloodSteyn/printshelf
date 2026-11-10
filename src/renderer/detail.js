// Right-hand panel for the selected model.
import { h, icon, fmtSize, fmtDate, fmtNum, fmtDuration, thumbUrl, toast } from './ui.js';

export function renderDetail(el, f, ctx, onClose) {
  const { A, call, native, S } = ctx;
  const m = f.meta || {};
  const isEntry = !!f.archive_id;
  const save = (patch) => call('set_details', { id: f.id, ...patch });

  const kv = [];
  const add = (k, v) => { if (v != null && v !== '') kv.push(h('dt', {}, k), h('dd', {}, v)); };
  add('Type', '.' + f.ext + (isEntry ? ' (inside an archive)' : ''));
  add('Size', fmtSize(f.size));
  add('Modified', fmtDate(f.mtime));
  if (f.tri_count) add('Triangles', fmtNum(f.tri_count));
  if (f.bx) add('Dimensions', `${f.bx.toFixed(1)} × ${f.by.toFixed(1)} × ${f.bz.toFixed(1)} mm`);
  if (f.volume > 0.01) {
    add('Mesh volume', `${(f.volume / 1000).toFixed(2)} cm³`);
    add('Solid weight', `~${((f.volume / 1000) * (S.settings.density || 1.24)).toFixed(0)} g at 100% infill`);
  }
  if (m.renderError) add('Preview', h('span', { style: { color: 'var(--warn)' } }, m.renderError));

  const print = [];
  const padd = (k, v) => { if (v != null && v !== '') print.push(h('dt', {}, k), h('dd', {}, v)); };
  padd('Slicer', m.application || m.slicer);
  padd('Printer', m.printer);
  padd('Nozzle', m.nozzle ? m.nozzle + ' mm' : '');
  padd('Layer', m.layerHeight ? m.layerHeight + ' mm' : '');
  padd('Profile', m.profile);
  padd('Bed', m.bed);
  padd('Plates', m.plates);
  if (m.filamentColors && m.filamentColors.length) {
    padd('Filaments', h('span', {}, h('span', { class: 'swatches' }, m.filamentColors.map((c) => h('i', { style: { background: c }, title: c }))),
      m.filamentTypes ? ' ' + [...new Set(m.filamentTypes)].join(', ') : ''));
  }
  padd('Print time', m.printSeconds ? fmtDuration(m.printSeconds) : m.printTime);
  padd('Filament', m.filamentGrams ? m.filamentGrams + ' g' : '');

  const tagInput = h('input', { class: 'input', placeholder: 'Add tag…', style: { width: '110px', padding: '2px 8px' },
    onKeydown: async (e) => {
      if (e.key !== 'Enter' || !e.target.value.trim()) return;
      await call('add_tags', { id: f.id, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) });
      ctx.refreshMeta();
    } });
  const tags = h('div', { class: 'row' },
    f.tags.map((t) => h('span', { class: 'chip' + (t.name === 'Multi-color' ? ' violet' : t.auto === 2 ? ' ai' : ''), title: t.auto === 1 ? 'Read from the file' : t.auto === 2 ? 'Suggested by AI' : 'Your tag' },
      h('a', { style: { color: 'inherit' }, onClick: () => A.filterTag(t.name) }, t.name),
      h('button', { title: 'Remove tag', onClick: async () => { await call('remove_tags', { id: f.id, tags: [t.name] }); ctx.refreshMeta(); } }, icon('x', 10)))),
    tagInput);

  const field = (label, key, placeholder) => h('div', { class: 'field' }, h('label', {}, label),
    h('input', { class: 'input', value: f[key] || '', placeholder, onChange: (e) => save({ [key]: e.target.value.trim() }) }));

  const fav = h('button', { class: 'btn' + (f.favorite ? ' on' : ''), title: 'Favorite', onClick: async () => { f.favorite = !f.favorite; fav.classList.toggle('on', f.favorite); await A.favorite([f.id], f.favorite); ctx.refreshMeta(); } }, icon('heart', 14));
  const printed = h('button', { class: 'btn' + (f.printed ? ' on' : ''), onClick: async () => { f.printed = !f.printed; printed.classList.toggle('on', f.printed); await A.printed([f.id], f.printed); } }, icon('check', 14), 'Printed');

  el.replaceChildren(
    h('div', { class: 'd-thumb', title: 'Open in viewer', onClick: () => A.view(f) },
      f.thumb_state === 1 ? h('img', { src: thumbUrl(f) }) : h('div', { class: 'ph', style: { color: '#3b4654' } }, icon('cube', 56)),
      h('button', { class: 'icon-btn close', title: 'Close panel', onClick: (e) => { e.stopPropagation(); onClose(); } }, icon('x', 14))),
    h('div', { class: 'd-body' },
      h('div', {}, h('div', { class: 'd-title' }, f.name), h('div', { class: 'd-path' }, f.path.replace('::', '  ›  '))),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onClick: () => A.view(f) }, icon('eye', 14), 'View'),
        h('button', { class: 'btn', onClick: (e) => (S.slicers.length === 1 ? A.openSlicer([f.id], S.slicers[0].name) : A.slicerMenu(e.currentTarget, [f.id])) }, icon('external', 14), 'Slicer'),
        h('button', { class: 'btn', title: 'Reveal in Explorer', onClick: () => native('reveal', { id: f.id }) }, icon('folder', 14)),
        fav),
      h('div', { class: 'row' },
        printed,
        h('button', { class: 'btn' + (f.queued ? ' on' : ''), onClick: () => A.queue([f.id]) }, icon('printer', 14), f.queued ? 'In queue' : 'Add to queue'),
        h('button', { class: 'btn', title: 'Add to a collection', onClick: (e) => A.collect(e.currentTarget, [f.id]) }, icon('layers', 14))),
      f.ai_description ? h('div', { class: 'sect' }, h('h4', {}, 'Description'), h('div', { style: { userSelect: 'text' } }, f.ai_description)) : null,
      h('div', { class: 'sect' }, h('h4', {}, 'Tags'), tags,
        h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn small', onClick: () => A.aiTag([f.id]) }, icon('spark', 12), f.ai_description ? 'Re-run AI tagging' : 'Describe and tag with AI'))),
      f.collections.length ? h('div', { class: 'sect' }, h('h4', {}, 'Collections'), h('div', { class: 'row' }, f.collections.map((c) => h('span', { class: 'chip accent' }, h('a', { onClick: () => A.go('library', { type: 'collection', id: c.id, name: c.name }) }, c.name))))) : null,
      h('div', { class: 'sect' }, h('h4', {}, 'Details'), h('dl', { class: 'kv' }, kv)),
      print.length ? h('div', { class: 'sect' }, h('h4', {}, 'Print settings in file'), h('dl', { class: 'kv' }, print)) : null,
      h('div', { class: 'sect' }, h('h4', {}, 'Creator & licence'),
        field('Creator', 'creator', 'Who made it'),
        field('Licence', 'license', 'e.g. CC BY-NC, personal use'),
        field('Source', 'source_url', 'https://…'),
        f.source_url ? h('a', { onClick: () => native('open_url', { url: f.source_url }) }, 'Open source page') : null),
      h('div', { class: 'sect' }, h('h4', {}, 'Notes'),
        h('textarea', { placeholder: 'Print settings, orientation, what went wrong last time…', value: f.notes || '', onChange: (e) => save({ notes: e.target.value }) })),
      f.companions && f.companions.length ? h('div', { class: 'sect' }, h('h4', {}, 'In the same folder'),
        f.companions.map((c) => h('div', { class: 'comp', title: c.name, onClick: () => (c.ext === 'pdf' ? native('open_default', { id: c.id }) : A.view(c)) },
          c.thumb_state === 1 ? h('img', { src: thumbUrl(c) }) : icon(c.kind === 'image' ? 'image' : 'file', 18), h('span', {}, c.name)))) : null,
      !isEntry ? h('div', { class: 'row' }, h('button', { class: 'btn small danger', onClick: () => A.trash([f.id]) }, icon('trash', 12), 'Move to Recycle Bin')) : null));
  void toast;
}
