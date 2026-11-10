// SQLite storage (Electron's built-in node:sqlite). All library state lives here;
// model files themselves are indexed in place and never moved by a scan.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const { PRIMARY_KINDS } = require('./formats');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  paused INTEGER DEFAULT 0, added_at INTEGER
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL,
  path TEXT UNIQUE NOT NULL,      -- full path; archive entries are "<archive>::<entry>"
  dir TEXT NOT NULL,              -- parent folder (or "<archive>::<inner dir>")
  name TEXT NOT NULL, ext TEXT, kind TEXT,
  size INTEGER, mtime INTEGER,
  archive_id INTEGER,             -- files.id of the containing archive, if any
  entry_path TEXT,
  hash TEXT, crc32 INTEGER,
  mesh_hash TEXT, moved_hash TEXT, tri_count INTEGER,
  bx REAL, by REAL, bz REAL, volume REAL, area REAL,
  thumb_state INTEGER DEFAULT 0,  -- 0 pending, 1 ready, 2 failed, 3 none
  geom_state INTEGER DEFAULT 0,   -- 0 pending, 1 done, 2 failed, 3 n/a
  thumb_ver INTEGER DEFAULT 0,
  favorite INTEGER DEFAULT 0, printed INTEGER DEFAULT 0,
  notes TEXT, creator TEXT, license TEXT, source_url TEXT,
  ai_description TEXT, ai_state INTEGER DEFAULT 0, embedding BLOB,
  meta TEXT, indexed_at INTEGER, seen INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS files_dir ON files(dir);
CREATE INDEX IF NOT EXISTS files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS files_mesh ON files(mesh_hash);
CREATE INDEX IF NOT EXISTS files_archive ON files(archive_id);
CREATE INDEX IF NOT EXISTS files_source ON files(source_id);
CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, auto INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS file_tags (file_id INTEGER, tag_id INTEGER, PRIMARY KEY(file_id, tag_id));
CREATE INDEX IF NOT EXISTS file_tags_tag ON file_tags(tag_id);
CREATE TABLE IF NOT EXISTS collections (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL COLLATE NOCASE, created_at INTEGER);
CREATE TABLE IF NOT EXISTS collection_files (collection_id INTEGER, file_id INTEGER, PRIMARY KEY(collection_id, file_id));
CREATE TABLE IF NOT EXISTS print_queue (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, qty INTEGER DEFAULT 1,
  status TEXT DEFAULT 'queued', note TEXT, added_at INTEGER
);
CREATE TABLE IF NOT EXISTS dupe_decisions (pair TEXT PRIMARY KEY, decision TEXT);
CREATE TABLE IF NOT EXISTS pending_imports (
  id INTEGER PRIMARY KEY, url TEXT, meta TEXT, created_at INTEGER, status TEXT DEFAULT 'waiting'
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

function open(file) {
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  return db;
}

const stmts = new Map();
function q(sql) {
  let s = stmts.get(sql);
  if (!s) { s = db.prepare(sql); stmts.set(sql, s); }
  return s;
}
const run = (sql, ...a) => q(sql).run(...a);
const get = (sql, ...a) => q(sql).get(...a);
const all = (sql, ...a) => q(sql).all(...a);

function tx(fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  importDir: '',            // where URL imports are stored (set on first run)
  inboxDir: '',             // watched folder for browser downloads (set on first run)
  inboxWindowMin: 15,
  maxMeshMB: 250,           // skip mesh parsing above this size
  ai: {
    provider: 'ollama',     // 'ollama' | 'openai'
    baseUrl: 'http://127.0.0.1:11434',
    visionModel: '',
    embedModel: '',
    apiKey: '',
  },
  slicerPaths: {},          // user overrides: name -> exe
  defaultSlicer: '',
  density: 1.24,
};

function getSettings() {
  const row = get('SELECT value FROM settings WHERE key = ?', 'app');
  const saved = row ? JSON.parse(row.value) : {};
  return { ...DEFAULT_SETTINGS, ...saved, ai: { ...DEFAULT_SETTINGS.ai, ...(saved.ai || {}) } };
}
function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch, ai: { ...cur.ai, ...(patch.ai || {}) } };
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'app', JSON.stringify(next));
  return next;
}

// ---------- tags ----------
function tagId(name, auto = 0) {
  name = String(name).trim().slice(0, 60);
  if (!name) return null;
  const row = get('SELECT id FROM tags WHERE name = ?', name);
  if (row) return row.id;
  return Number(run('INSERT INTO tags(name, auto) VALUES(?, ?)', name, auto ? 1 : 0).lastInsertRowid);
}
function addTags(fileIds, names, auto = 0) {
  tx(() => {
    for (const n of names) {
      const tid = tagId(n, auto);
      if (!tid) continue;
      for (const fid of fileIds) run('INSERT OR IGNORE INTO file_tags(file_id, tag_id) VALUES(?, ?)', fid, tid);
    }
  });
}
function removeTags(fileIds, names) {
  tx(() => {
    for (const n of names) {
      const row = get('SELECT id FROM tags WHERE name = ?', String(n).trim());
      if (!row) continue;
      for (const fid of fileIds) run('DELETE FROM file_tags WHERE file_id = ? AND tag_id = ?', fid, row.id);
    }
    run('DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM file_tags)');
  });
}
function listTags() {
  return all(`SELECT t.id, t.name, t.auto, COUNT(ft.file_id) AS count FROM tags t
              LEFT JOIN file_tags ft ON ft.tag_id = t.id GROUP BY t.id ORDER BY count DESC, t.name`);
}
function tagsOf(fileId) {
  return all(`SELECT t.name, t.auto FROM tags t JOIN file_tags ft ON ft.tag_id = t.id
              WHERE ft.file_id = ? ORDER BY t.auto, t.name`, fileId);
}

// ---------- collections ----------
function collectionId(name) {
  name = String(name).trim().slice(0, 80);
  const row = get('SELECT id FROM collections WHERE name = ?', name);
  if (row) return row.id;
  return Number(run('INSERT INTO collections(name, created_at) VALUES(?, ?)', name, Date.now()).lastInsertRowid);
}
function listCollections() {
  return all(`SELECT c.id, c.name, COUNT(cf.file_id) AS count,
                (SELECT cf2.file_id FROM collection_files cf2 JOIN files f ON f.id = cf2.file_id
                 WHERE cf2.collection_id = c.id AND f.thumb_state = 1 LIMIT 1) AS cover
              FROM collections c LEFT JOIN collection_files cf ON cf.collection_id = c.id
              GROUP BY c.id ORDER BY c.name`);
}
function addToCollection(name, fileIds) {
  const cid = collectionId(name);
  tx(() => { for (const f of fileIds) run('INSERT OR IGNORE INTO collection_files VALUES(?, ?)', cid, f); });
  return cid;
}
function removeFromCollection(cid, fileIds) {
  tx(() => { for (const f of fileIds) run('DELETE FROM collection_files WHERE collection_id = ? AND file_id = ?', cid, f); });
}
function deleteCollection(cid) {
  run('DELETE FROM collection_files WHERE collection_id = ?', cid);
  run('DELETE FROM collections WHERE id = ?', cid);
}

// ---------- file queries ----------
const LIGHT = `f.id, f.name, f.ext, f.kind, f.size, f.mtime, f.path, f.dir, f.thumb_state, f.thumb_ver,
  f.favorite, f.printed, f.archive_id, f.tri_count,
  (SELECT group_concat(t.name, '|') FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id) AS tags`;

const SORTS = {
  name: 'f.name COLLATE NOCASE ASC',
  name_desc: 'f.name COLLATE NOCASE DESC',
  newest: 'f.mtime DESC',
  oldest: 'f.mtime ASC',
  largest: 'f.size DESC',
  smallest: 'f.size ASC',
  added: 'f.indexed_at DESC, f.id DESC',
};

function likeEscape(s) { return s.replace(/[\\%_]/g, (m) => '\\' + m); }

/**
 * filter: { q, show: 'models'|'all'|<ext>, dir, flat, tags[], collection, favorite,
 *           printed: 'yes'|'no', sort, limit, ids[] }
 */
function listFiles(filter = {}) {
  const where = [];
  const args = [];
  const show = filter.show || 'models';
  if (show === 'models') where.push(`f.kind IN (${[...PRIMARY_KINDS].map((k) => `'${k}'`).join(',')})`);
  else if (show === 'all') where.push(`f.kind != 'archive'`);
  else if (show === 'archives') where.push(`f.kind = 'archive'`);
  else { where.push('f.ext = ?'); args.push(show); }

  if (filter.dir) {
    if (filter.flat === false) { where.push('f.dir = ?'); args.push(filter.dir); }
    else {
      where.push(`(f.dir = ? OR f.dir LIKE ? ESCAPE '\\' OR f.dir LIKE ? ESCAPE '\\' OR f.dir LIKE ? ESCAPE '\\')`);
      const e = likeEscape(filter.dir);
      args.push(filter.dir, e + '\\\\%', e + '::%', e + '/%');
    }
  }
  if (filter.source) { where.push('f.source_id = ?'); args.push(filter.source); }
  if (filter.favorite) where.push('f.favorite = 1');
  if (filter.printed === 'yes') where.push('f.printed = 1');
  if (filter.printed === 'no') where.push('f.printed = 0');
  if (filter.untagged) where.push('NOT EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.auto = 0)');
  if (filter.collection) {
    where.push('f.id IN (SELECT file_id FROM collection_files WHERE collection_id = ?)');
    args.push(filter.collection);
  }
  for (const t of filter.tags || []) {
    where.push('f.id IN (SELECT ft.file_id FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.name = ?)');
    args.push(t);
  }
  if (filter.ids) {
    const ids = filter.ids.map(Number).filter(Number.isFinite);
    where.push(`f.id IN (${ids.join(',') || 'NULL'})`);
  }
  for (const word of String(filter.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8)) {
    const w = '%' + likeEscape(word) + '%';
    where.push(`(f.name LIKE ? ESCAPE '\\' OR f.path LIKE ? ESCAPE '\\' OR f.ai_description LIKE ? ESCAPE '\\'
      OR f.creator LIKE ? ESCAPE '\\' OR f.notes LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.name LIKE ? ESCAPE '\\'))`);
    args.push(w, w, w, w, w, w);
  }
  const sql = `SELECT ${LIGHT} FROM files f ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY ${SORTS[filter.sort] || SORTS.name} LIMIT ?`;
  return db.prepare(sql).all(...args, Math.min(Number(filter.limit) || 30000, 30000));
}

function getFile(id) {
  const f = get('SELECT * FROM files WHERE id = ?', id);
  if (!f) return null;
  delete f.embedding;
  f.meta = f.meta ? JSON.parse(f.meta) : {};
  f.tags = tagsOf(id);
  f.collections = all(`SELECT c.id, c.name FROM collections c JOIN collection_files cf ON cf.collection_id = c.id WHERE cf.file_id = ?`, id);
  f.queued = !!get(`SELECT 1 AS x FROM print_queue WHERE file_id = ? AND status = 'queued'`, id);
  return f;
}

function companions(file) {
  return all(`SELECT id, name, ext, kind, size, thumb_state, thumb_ver FROM files
              WHERE dir = ? AND id != ? AND kind IN ('image','doc','video') ORDER BY kind, name LIMIT 60`, file.dir, file.id);
}

function subdirs(dir) {
  // Direct child folders under `dir`. Archives act as folders: entries at the
  // archive root have dir = "<archive path>", nested ones "<archive path>::inner/dir".
  const e = likeEscape(dir);
  const rows = all(`SELECT DISTINCT dir FROM files WHERE dir LIKE ? ESCAPE '\\' OR dir LIKE ? ESCAPE '\\' OR dir LIKE ? ESCAPE '\\'`,
    e + '\\\\%', e + '::%', e + '/%');
  const out = new Map();
  for (const { dir: d } of rows) {
    let rest = d.slice(dir.length);
    let join;
    if (rest.startsWith('::')) { rest = rest.slice(2); join = '::'; }
    else { join = rest[0]; rest = rest.slice(1); }
    const cut = rest.search(/::|[\\/]/);
    const name = cut < 0 ? rest : rest.slice(0, cut);
    if (name) out.set(name, dir + join + name);
  }
  for (const a of all(`SELECT path, name FROM files WHERE dir = ? AND kind = 'archive'`, dir)) out.set(a.name, a.path);
  return [...out.entries()].map(([name, p]) => ({ name, path: p, archive: /\.(zip|rar|7z|tar|tgz|gz)$/i.test(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function stats() {
  const s = get(`SELECT COUNT(*) AS files, COALESCE(SUM(CASE WHEN archive_id IS NULL THEN size END), 0) AS bytes,
    SUM(CASE WHEN kind IN ('model','cad','gcode','laser') THEN 1 ELSE 0 END) AS models,
    SUM(CASE WHEN kind = 'archive' THEN 1 ELSE 0 END) AS archives,
    SUM(favorite) AS favorites,
    SUM(CASE WHEN thumb_state = 0 OR geom_state = 0 THEN 1 ELSE 0 END) AS pendingThumbs,
    SUM(CASE WHEN hash IS NULL AND archive_id IS NULL THEN 1 ELSE 0 END) AS pendingHash
    FROM files`);
  s.tags = get('SELECT COUNT(*) AS n FROM tags').n;
  s.collections = get('SELECT COUNT(*) AS n FROM collections').n;
  s.queue = get(`SELECT COUNT(*) AS n FROM print_queue WHERE status = 'queued'`).n;
  s.byExt = all(`SELECT ext, COUNT(*) AS n FROM files WHERE kind IN ('model','cad','gcode','laser') GROUP BY ext ORDER BY n DESC`);
  return s;
}

function deleteFileRows(ids) {
  tx(() => {
    for (const id of ids) {
      for (const child of all('SELECT id FROM files WHERE archive_id = ?', id)) purge(child.id);
      purge(id);
    }
  });
}
function purge(id) {
  run('DELETE FROM file_tags WHERE file_id = ?', id);
  run('DELETE FROM collection_files WHERE file_id = ?', id);
  run('DELETE FROM print_queue WHERE file_id = ?', id);
  run('DELETE FROM files WHERE id = ?', id);
}

module.exports = {
  open, run, get, all, tx, raw: () => db,
  getSettings, saveSettings,
  tagId, addTags, removeTags, listTags, tagsOf,
  collectionId, listCollections, addToCollection, removeFromCollection, deleteCollection,
  listFiles, getFile, companions, subdirs, stats, deleteFileRows,
};
