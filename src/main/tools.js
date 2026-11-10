// One set of operations used by both the app window (IPC) and agents (MCP over
// the local HTTP API). `agent` holds what agents may call: it can read, tag,
// organise and import, but never deletes or moves your existing files.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const scanner = require('./scanner');
const jobs = require('./jobs');
const dupes = require('./dupes');
const ai = require('./ai');
const importer = require('./importer');
const slicers = require('./slicers');

const ids = (a) => (Array.isArray(a.ids) ? a.ids : a.id != null ? [a.id] : []).map(Number).filter(Number.isFinite);

function forAgent(row) {
  const f = db.get('SELECT creator, license, source_url, ai_description, notes, bx, by, bz FROM files WHERE id = ?', row.id) || {};
  return {
    id: row.id, name: row.name, format: row.ext, kind: row.kind, size_bytes: row.size, path: row.path,
    in_archive: !!row.archive_id, tags: row.tags ? row.tags.split('|') : [],
    favorite: !!row.favorite, printed: !!row.printed, has_thumbnail: row.thumb_state === 1,
    triangles: row.tri_count || undefined,
    size_mm: f.bx ? [f.bx, f.by, f.bz].map((v) => Math.round(v * 10) / 10) : undefined,
    creator: f.creator || undefined, license: f.license || undefined, source_url: f.source_url || undefined,
    description: f.ai_description || undefined, notes: f.notes || undefined,
  };
}

const agent = {
  library_stats() {
    return { ...db.stats(), sources: db.all('SELECT id, path, name, paused FROM sources'), import_folder: db.getSettings().importDir, inbox_folder: db.getSettings().inboxDir };
  },

  async search_models(a = {}) {
    const limit = Math.min(Number(a.limit) || 25, 200);
    const filter = {
      q: a.query, show: a.format ? String(a.format).toLowerCase().replace(/^\./, '') : a.include_companions ? 'all' : 'models',
      tags: a.tags, favorite: a.favorite, printed: a.printed === true ? 'yes' : a.printed === false ? 'no' : undefined,
      untagged: a.untagged, dir: a.folder, sort: a.sort,
    };
    if (a.collection) {
      const c = db.get('SELECT id FROM collections WHERE name = ?', String(a.collection));
      if (!c) return { total: 0, results: [], note: `No collection named "${a.collection}"` };
      filter.collection = c.id;
    }
    if (a.semantic && a.query) {
      const hits = await ai.semanticSearch(a.query, limit);
      if (hits && hits.length) {
        const rows = db.listFiles({ ...filter, q: '', ids: hits.map((h) => h.id) });
        const order = new Map(hits.map((h, i) => [h.id, i]));
        rows.sort((x, y) => order.get(x.id) - order.get(y.id));
        return { total: rows.length, mode: 'semantic', results: rows.map(forAgent) };
      }
    }
    const rows = db.listFiles(filter);
    return { total: rows.length, mode: 'keyword', results: rows.slice(0, limit).map(forAgent) };
  },

  get_model(a) {
    const f = db.getFile(Number(a.id));
    if (!f) throw new Error('No model with id ' + a.id);
    return {
      id: f.id, name: f.name, format: f.ext, kind: f.kind, path: f.path, folder: f.dir, size_bytes: f.size,
      modified: new Date(f.mtime).toISOString(), in_archive: !!f.archive_id,
      tags: f.tags.map((t) => t.name), collections: f.collections.map((c) => c.name),
      favorite: !!f.favorite, printed: !!f.printed, in_print_queue: f.queued,
      creator: f.creator, license: f.license, source_url: f.source_url, notes: f.notes, description: f.ai_description,
      triangles: f.tri_count, size_mm: f.bx ? [f.bx, f.by, f.bz] : null, volume_cm3: f.volume ? f.volume / 1000 : null,
      slicer_info: f.meta, has_thumbnail: f.thumb_state === 1,
      companion_files: db.companions(f).map((c) => ({ id: c.id, name: c.name })),
    };
  },

  async get_thumbnail(a) {
    const f = db.get('SELECT id, thumb_state FROM files WHERE id = ?', Number(a.id));
    if (!f) throw new Error('No model with id ' + a.id);
    if (f.thumb_state !== 1) throw new Error('This file has no thumbnail yet');
    const buf = await fs.promises.readFile(jobs.thumbPath(f.id));
    return { __image: buf.toString('base64'), mime: buf[0] === 0xff ? 'image/jpeg' : 'image/png' };
  },

  list_tags() { return db.listTags().map((t) => ({ name: t.name, count: t.count, source: t.auto === 1 ? 'file' : t.auto === 2 ? 'ai' : 'manual' })); },
  list_collections() { return db.listCollections().map((c) => ({ id: c.id, name: c.name, count: c.count })); },
  list_folders(a = {}) {
    if (!a.path) return db.all('SELECT path, name FROM sources').map((s) => ({ name: s.name, path: s.path }));
    return db.subdirs(String(a.path));
  },

  add_tags(a) { const l = ids(a); db.addTags(l, a.tags || []); l.forEach(jobs.notify); return { tagged: l.length, tags: a.tags }; },
  remove_tags(a) { const l = ids(a); db.removeTags(l, a.tags || []); l.forEach(jobs.notify); return { updated: l.length }; },

  set_details(a) {
    const l = ids(a);
    const cols = { creator: 'creator', license: 'license', source_url: 'source_url', notes: 'notes' };
    db.tx(() => {
      for (const id of l) {
        for (const [k, col] of Object.entries(cols)) if (a[k] !== undefined) db.run(`UPDATE files SET ${col} = ? WHERE id = ?`, a[k] === '' ? null : String(a[k]).slice(0, 4000), id);
        if (a.favorite !== undefined) db.run('UPDATE files SET favorite = ? WHERE id = ?', a.favorite ? 1 : 0, id);
        if (a.printed !== undefined) db.run('UPDATE files SET printed = ? WHERE id = ?', a.printed ? 1 : 0, id);
        if (a.description !== undefined) db.run('UPDATE files SET ai_description = ? WHERE id = ?', String(a.description).slice(0, 400), id);
      }
    });
    l.forEach(jobs.notify);
    return { updated: l.length };
  },

  add_to_collection(a) { const l = ids(a); const id = db.addToCollection(a.collection, l); jobs.notify(-1); return { collection_id: id, added: l.length }; },
  remove_from_collection(a) {
    const c = db.get('SELECT id FROM collections WHERE name = ?', String(a.collection));
    if (!c) throw new Error('No such collection');
    db.removeFromCollection(c.id, ids(a)); jobs.notify(-1);
    return { ok: true };
  },

  print_queue_list() {
    return db.all(`SELECT q.id AS entry_id, q.file_id, q.qty, q.status, q.note, q.added_at, f.name, f.ext, f.path, f.thumb_state, f.thumb_ver, f.meta
                   FROM print_queue q JOIN files f ON f.id = q.file_id ORDER BY (q.status = 'queued') DESC, q.id`)
      .map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : {} }));
  },
  print_queue_add(a) {
    const l = ids(a);
    for (const id of l) {
      if (!db.get('SELECT 1 AS x FROM files WHERE id = ?', id)) throw new Error('No model with id ' + id);
      db.run('INSERT INTO print_queue(file_id, qty, note, added_at) VALUES(?, ?, ?, ?)', id, Math.max(1, Number(a.qty) || 1), a.note || null, Date.now());
      jobs.notify(id);
    }
    return { queued: l.length };
  },
  print_queue_update(a) {
    const e = db.get('SELECT * FROM print_queue WHERE id = ?', Number(a.entry_id));
    if (!e) throw new Error('No such queue entry');
    if (a.remove) db.run('DELETE FROM print_queue WHERE id = ?', e.id);
    else {
      const status = ['queued', 'printing', 'done'].includes(a.status) ? a.status : e.status;
      db.run('UPDATE print_queue SET status = ?, qty = ?, note = ? WHERE id = ?', status, Math.max(1, Number(a.qty) || e.qty), a.note !== undefined ? a.note : e.note, e.id);
      if (status === 'done') db.run('UPDATE files SET printed = 1 WHERE id = ?', e.file_id);
    }
    jobs.notify(e.file_id);
    return { ok: true };
  },

  import_from_url: (a) => importer.importFromUrl(a),
  import_file: (a) => importer.importFile(a),
  list_pending_imports: () => importer.listPending(),

  async rescan_library() { const r = await scanner.scanAll(); scanner.hashPending(); return r; },

  find_duplicates() {
    const d = dupes.find();
    return {
      certain_groups: d.certain.length,
      reclaimable_bytes: d.certain.reduce((a, g) => a + g.reclaim, 0),
      likely_pairs: d.likely.length, archive_vs_unpacked: d.archives.length, folder_matches: d.folders.length,
      top_certain: d.certain.slice(0, 15).map((g) => ({ keep: g.keep, reason: g.reason, files: g.members.map((m) => ({ id: m.id, path: m.path, match: m.match })) })),
      top_likely: d.likely.slice(0, 15).map((p) => ({ badge: p.badge, files: p.members.map((m) => ({ id: m.id, path: m.path })) })),
      archives: d.archives.slice(0, 15), folders: d.folders.slice(0, 15),
      note: 'Read-only. Removing duplicates is done by the user in the app.',
    };
  },

  ai_status: () => ai.status().then((s) => ({ ...s, run: ai.progress() })),
  ai_tag(a = {}) { const l = ids(a); return ai.tagMany(l.length ? l : null); },
};

// ---------- app-window-only operations ----------
const ui = {
  list_files: (f) => db.listFiles(f),
  get_file(a) { const f = db.getFile(a.id); if (f) f.companions = db.companions(f); return f; },
  subdirs: (a) => db.subdirs(a.path),
  sources: () => db.all('SELECT s.*, (SELECT COUNT(*) FROM files f WHERE f.source_id = s.id) AS count FROM sources s ORDER BY s.name'),
  async add_source(a) {
    const p = path.resolve(a.path);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('Not a folder: ' + p);
    db.run('INSERT OR IGNORE INTO sources(path, name, added_at) VALUES(?, ?, ?)', p, path.basename(p) || p, Date.now());
    const s = db.get('SELECT * FROM sources WHERE path = ?', p);
    importer.watchSources();
    scanner.scanSource(s).then(() => scanner.hashPending());
    return s;
  },
  remove_source(a) {
    const rows = db.all('SELECT id FROM files WHERE source_id = ?', a.id).map((r) => r.id);
    db.tx(() => rows.forEach(scanner.removeRow));
    db.run('DELETE FROM sources WHERE id = ?', a.id);
    importer.watchSources();
    return { removed: rows.length };
  },
  pause_source(a) { db.run('UPDATE sources SET paused = ? WHERE id = ?', a.paused ? 1 : 0, a.id); importer.watchSources(); return { ok: true }; },
  async rescan(a = {}) {
    if (a.id) await scanner.scanSource(db.get('SELECT * FROM sources WHERE id = ?', a.id));
    else await scanner.scanAll();
    scanner.hashPending();
    return { ok: true };
  },
  get_settings: () => db.getSettings(),
  save_settings(a) { const s = db.saveSettings(a); importer.watchInbox(); slicers.detect(true); return s; },
  prioritize(a) { jobs.prioritize(a.ids || []); return true; },
  retry_thumbs() { jobs.retryFailed(); return true; },
  duplicates: () => dupes.find(),
  dupe_decide(a) { dupes.decide(a.pair, a.decision); return true; },
  slicers: () => slicers.detect(),
  delete_collection(a) { db.deleteCollection(a.id); return true; },
  rename_collection(a) { db.run('UPDATE collections SET name = ? WHERE id = ?', String(a.name).trim().slice(0, 80), a.id); return true; },
  cancel_pending(a) { importer.cancelPending(a.id); return true; },
  ai_cancel() { ai.cancel(); return true; },
  ai_tag_one: (a) => ai.tagOne(a.id),
  async semantic(a) { return ai.semanticSearch(a.query, a.limit || 60); },
};

module.exports = { agent, ui };
