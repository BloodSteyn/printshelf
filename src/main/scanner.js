// Walks source folders and keeps the index in step with what is on disk.
// Nothing is renamed, moved or uploaded: a scan only reads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');
const db = require('./db');
const archives = require('./archives');
const { kindOf, extOf, MESH_EXTS } = require('./formats');

const events = new EventEmitter();
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules', '.git', '.thumbnails', '__macosx']);
const THUMB_KINDS = new Set(['image', 'gcode']);
const THUMB_EXTS = new Set(['svg', 'dxf', 'lbrn', 'lbrn2', 'xcs']);

let ctx = { cacheDir: '', thumbDir: '' };
function init(c) { ctx = c; }

function initialStates(ext, kind, size) {
  const tooBig = size > db.getSettings().maxMeshMB * 1024 * 1024;
  const mesh = MESH_EXTS.has(ext);
  const thumb = (mesh && (!tooBig || ext === '3mf')) || THUMB_KINDS.has(kind) || THUMB_EXTS.has(ext) ? 0 : 3;
  const geom = mesh && !tooBig ? 0 : 3;
  return { thumb, geom };
}

function upsert(sourceId, full, dir, name, size, mtime, scanId, extra = {}) {
  const kind = kindOf(name);
  if (!kind) return null;
  const ext = extOf(name);
  const row = db.get('SELECT id, size, mtime FROM files WHERE path = ?', full);
  if (row && row.size === size && row.mtime === mtime) {
    db.run('UPDATE files SET seen = ?, source_id = ? WHERE id = ?', scanId, sourceId, row.id);
    if (kind === 'archive') db.run('UPDATE files SET seen = ? WHERE archive_id = ?', scanId, row.id);
    return { id: row.id, changed: false, kind };
  }
  const st = initialStates(ext, kind, size);
  if (row) {
    db.run(`UPDATE files SET size = ?, mtime = ?, seen = ?, source_id = ?, hash = NULL, crc32 = ?, mesh_hash = NULL, moved_hash = NULL,
            tri_count = NULL, thumb_state = ?, geom_state = ?, meta = NULL, indexed_at = ? WHERE id = ?`,
      size, mtime, scanId, sourceId, extra.crc ?? null, st.thumb, st.geom, Date.now(), row.id);
    return { id: row.id, changed: true, kind };
  }
  const r = db.run(`INSERT INTO files(source_id, path, dir, name, ext, kind, size, mtime, archive_id, entry_path, crc32,
                    thumb_state, geom_state, indexed_at, seen) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    sourceId, full, dir, name, ext, kind, size, mtime, extra.archiveId ?? null, extra.entryPath ?? null, extra.crc ?? null,
    st.thumb, st.geom, Date.now(), scanId);
  return { id: Number(r.lastInsertRowid), changed: true, kind, isNew: true };
}

async function indexArchive(sourceId, archiveId, archivePath, mtime, scanId) {
  let entries;
  try { entries = await archives.listEntries(archivePath); }
  catch (e) { db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify({ archiveError: String(e.message).slice(0, 200) }), archiveId); return 0; }
  let n = 0;
  db.tx(() => {
    db.run('UPDATE files SET seen = -1 WHERE archive_id = ?', archiveId);
    for (const e of entries) {
      const clean = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
      if (!clean || clean.includes('__MACOSX/')) continue;
      const name = clean.slice(clean.lastIndexOf('/') + 1);
      const k = kindOf(name);
      if (!k || k === 'archive') continue; // nested archives are not opened
      const inner = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
      const dir = inner ? archivePath + '::' + inner : archivePath;
      upsert(sourceId, archivePath + '::' + clean, dir, name, e.size, mtime, scanId, { archiveId, entryPath: e.name, crc: e.crc });
      n++;
    }
    const gone = db.all('SELECT id FROM files WHERE archive_id = ? AND seen = -1', archiveId).map((r) => r.id);
    if (gone.length) for (const id of gone) removeRow(id);
  });
  return n;
}

function removeRow(id) {
  db.run('DELETE FROM file_tags WHERE file_id = ?', id);
  db.run('DELETE FROM collection_files WHERE file_id = ?', id);
  db.run('DELETE FROM print_queue WHERE file_id = ?', id);
  db.run('DELETE FROM files WHERE id = ?', id);
  fs.promises.unlink(path.join(ctx.thumbDir, id + '.png')).catch(() => {});
}

const scanning = new Set();
let scanCounter = Date.now();

async function scanSource(source) {
  if (scanning.has(source.id) || source.paused) return { skipped: true };
  scanning.add(source.id);
  const scanId = ++scanCounter;
  let found = 0, added = 0;
  const pendingArchives = [];
  try {
    if (!fs.existsSync(source.path)) throw new Error('Folder not reachable: ' + source.path);
    const stack = [source.path];
    while (stack.length) {
      const dir = stack.pop();
      let items;
      try { items = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
      const batch = [];
      for (const it of items) {
        if (it.isDirectory()) {
          if (!SKIP_DIRS.has(it.name.toLowerCase()) && !it.name.startsWith('.')) stack.push(path.join(dir, it.name));
        } else if (it.isFile() && kindOf(it.name)) {
          const full = path.join(dir, it.name);
          try { const st = await fs.promises.stat(full); batch.push([full, it.name, st.size, Math.floor(st.mtimeMs)]); } catch { /* vanished */ }
        }
      }
      if (batch.length) {
        db.tx(() => {
          for (const [full, name, size, mtime] of batch) {
            const r = upsert(source.id, full, dir, name, size, mtime, scanId);
            if (!r) continue;
            found++;
            if (r.isNew) added++;
            if (r.kind === 'archive' && r.changed) pendingArchives.push([r.id, full, mtime]);
          }
        });
        events.emit('progress', { source: source.id, found, phase: 'scan' });
      }
    }
    for (const [id, full, mtime] of pendingArchives) {
      found += await indexArchive(source.id, id, full, mtime, scanId);
      events.emit('progress', { source: source.id, found, phase: 'archives' });
    }
    const gone = db.all('SELECT id FROM files WHERE source_id = ? AND seen != ?', source.id, scanId).map((r) => r.id);
    if (gone.length) db.tx(() => gone.forEach(removeRow));
    scanning.delete(source.id);
    events.emit('done', { source: source.id, found, added, removed: gone.length });
    return { found, added, removed: gone.length };
  } catch (e) {
    scanning.delete(source.id);
    events.emit('done', { source: source.id, error: e.message });
    return { error: e.message };
  } finally {
    scanning.delete(source.id);
  }
}

async function scanAll() {
  const out = [];
  for (const s of db.all('SELECT * FROM sources ORDER BY id')) out.push({ source: s.path, ...(await scanSource(s)) });
  return out;
}

/** Index one file that already sits inside a source (used right after an import). */
async function indexFile(full) {
  const src = db.all('SELECT * FROM sources').filter((s) => full.toLowerCase().startsWith(s.path.toLowerCase() + path.sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!src) return null;
  const st = await fs.promises.stat(full);
  const r = upsert(src.id, full, path.dirname(full), path.basename(full), st.size, Math.floor(st.mtimeMs), ++scanCounter);
  if (r && r.kind === 'archive' && r.changed) await indexArchive(src.id, r.id, full, Math.floor(st.mtimeMs), scanCounter);
  events.emit('done', { source: src.id });
  return r ? r.id : null;
}

// ---------- local path resolution (extracts archive entries on demand) ----------
const extracting = new Map();
async function resolveLocalPath(file) {
  if (!file.archive_id) return file.path;
  const dest = path.join(ctx.cacheDir, `${file.id}.${file.ext}`);
  if (fs.existsSync(dest)) return dest;
  if (extracting.has(dest)) return extracting.get(dest);
  const arch = db.get('SELECT path FROM files WHERE id = ?', file.archive_id);
  if (!arch) throw new Error('Archive missing from index');
  const p = archives.extractEntry(arch.path, file.entry_path, dest).finally(() => extracting.delete(dest));
  extracting.set(dest, p);
  return p;
}
const extractedPath = (file) => path.join(ctx.cacheDir, `${file.id}.${file.ext}`);
function dropExtracted(file) {
  if (file.archive_id) fs.promises.unlink(extractedPath(file)).catch(() => {});
}

// ---------- hashing ----------
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const sha = crypto.createHash('sha1');
    let crc = 0;
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on('data', (c) => { sha.update(c); crc = zlib.crc32(c, crc); })
      .on('end', () => resolve({ hash: sha.digest('hex'), crc: crc >>> 0 }))
      .on('error', reject);
  });
}

let hashing = false;
async function hashPending() {
  if (hashing) return;
  hashing = true;
  try {
    for (;;) {
      const rows = db.all('SELECT id, path FROM files WHERE hash IS NULL AND archive_id IS NULL ORDER BY size LIMIT 25');
      if (!rows.length) break;
      for (const r of rows) {
        try { const h = await hashFile(r.path); db.run('UPDATE files SET hash = ?, crc32 = ? WHERE id = ?', h.hash, h.crc, r.id); }
        catch { db.run(`UPDATE files SET hash = 'unreadable:' || id WHERE id = ?`, r.id); }
      }
      events.emit('progress', { phase: 'hash' });
    }
  } finally { hashing = false; }
}

module.exports = { init, events, scanSource, scanAll, indexFile, resolveLocalPath, dropExtracted, extractedPath, hashFile, hashPending, removeRow, isScanning: () => scanning.size > 0 };
