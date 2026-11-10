// Thumbnail + geometry pipeline. The hidden worker window asks for one job at a
// time; embedded previews are resolved here first so the worker only parses a
// mesh when it has to.
const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const scanner = require('./scanner');
const embedded = require('./embedded');

let thumbDir = '';
let priority = [];
const inFlight = new Set();
function init(c) { thumbDir = c.thumbDir; }

function prioritize(ids) { priority = ids.slice(0, 200); }

function pick() {
  while (priority.length) {
    const id = priority.shift();
    const f = db.get('SELECT * FROM files WHERE id = ? AND (thumb_state = 0 OR geom_state = 0)', id);
    if (f && !inFlight.has(f.id)) return f;
  }
  const skip = [...inFlight].join(',') || '0';
  return db.raw().prepare(`SELECT * FROM files WHERE (thumb_state = 0 OR geom_state = 0) AND id NOT IN (${skip})
                           ORDER BY (thumb_state = 0) DESC, size ASC LIMIT 1`).get();
}

async function saveThumb(id, buf) {
  await fs.promises.writeFile(path.join(thumbDir, id + '.png'), buf);
  db.run('UPDATE files SET thumb_state = 1, thumb_ver = thumb_ver + 1 WHERE id = ?', id);
}

async function nextJob() {
  for (let guard = 0; guard < 500; guard++) {
    const f = pick();
    if (!f) return null;
    inFlight.add(f.id);
    try {
      if (embedded.HANDLED.has(f.ext) && f.thumb_state === 0 && !f.meta) {
        const local = await scanner.resolveLocalPath(f);
        const r = await embedded.extract(local, f.ext);
        db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify(r.meta || {}), f.id);
        if (r.meta && (r.meta.designer || r.meta.license)) {
          db.run('UPDATE files SET creator = COALESCE(creator, ?), license = COALESCE(license, ?) WHERE id = ?', r.meta.designer || null, r.meta.license || null, f.id);
        }
        if (r.tags.length) db.addTags([f.id], r.tags, 1);
        if (r.thumb && r.thumb.length > 64) { await saveThumb(f.id, r.thumb); f.thumb_state = 1; }
        else if (f.geom_state !== 0) { db.run('UPDATE files SET thumb_state = 3 WHERE id = ?', f.id); f.thumb_state = 3; }
      } else if (embedded.HANDLED.has(f.ext) && f.thumb_state === 0 && f.geom_state !== 0) {
        db.run('UPDATE files SET thumb_state = 3 WHERE id = ?', f.id); f.thumb_state = 3;
      }
      if (f.thumb_state !== 0 && f.geom_state !== 0) {
        await finish(f);
        continue;
      }
      return { id: f.id, ext: f.ext, kind: f.kind, name: f.name, size: f.size, needThumb: f.thumb_state === 0, needGeom: f.geom_state === 0 };
    } catch (e) {
      db.run('UPDATE files SET thumb_state = CASE WHEN thumb_state = 0 THEN 2 ELSE thumb_state END, geom_state = CASE WHEN geom_state = 0 THEN 2 ELSE geom_state END WHERE id = ?', f.id);
      await finish(f);
    }
  }
  return null;
}

async function finish(f) {
  if (f.archive_id && !f.hash) {
    const p = scanner.extractedPath(f);
    if (fs.existsSync(p)) {
      try {
        const h = await scanner.hashFile(p);
        db.run('UPDATE files SET hash = ?, crc32 = COALESCE(crc32, ?) WHERE id = ?', h.hash, h.crc, f.id);
      } catch { /* entry stays unhashed */ }
    }
  }
  scanner.dropExtracted(f);
  inFlight.delete(f.id);
  notify(f.id);
}

async function completeJob(id, result) {
  const f = db.get('SELECT * FROM files WHERE id = ?', id);
  if (!f) { inFlight.delete(id); return; }
  if (result.thumb && f.thumb_state === 0) await saveThumb(id, Buffer.from(result.thumb));
  else if (f.thumb_state === 0) db.run('UPDATE files SET thumb_state = 2 WHERE id = ?', id);
  if (f.geom_state === 0) {
    const g = result.geom;
    if (g) {
      db.run(`UPDATE files SET geom_state = 1, mesh_hash = ?, moved_hash = ?, tri_count = ?, bx = ?, by = ?, bz = ?, volume = ?, area = ? WHERE id = ?`,
        g.meshHash, g.movedHash, g.triCount, g.bx, g.by, g.bz, g.volume, g.area, id);
    } else db.run('UPDATE files SET geom_state = 2 WHERE id = ?', id);
  }
  if (result.error) {
    const meta = f.meta ? JSON.parse(f.meta) : {};
    meta.renderError = String(result.error).slice(0, 200);
    db.run('UPDATE files SET meta = ? WHERE id = ?', JSON.stringify(meta), id);
  }
  await finish(f);
}

function failInFlight(reason) {
  for (const id of inFlight) {
    db.run('UPDATE files SET thumb_state = CASE WHEN thumb_state = 0 THEN 2 ELSE thumb_state END, geom_state = CASE WHEN geom_state = 0 THEN 2 ELSE geom_state END WHERE id = ?', id);
    notify(id);
  }
  inFlight.clear();
  void reason;
}

function retryFailed() {
  db.run('UPDATE files SET thumb_state = 0 WHERE thumb_state = 2');
  db.run('UPDATE files SET geom_state = 0 WHERE geom_state = 2');
}

// batched change notifications to the UI
let pending = new Set();
let timer = null;
let listener = () => {};
function onUpdate(fn) { listener = fn; }
function notify(id) {
  pending.add(id);
  if (!timer) timer = setTimeout(() => { const ids = [...pending]; pending = new Set(); timer = null; listener(ids); }, 400);
}

module.exports = { init, nextJob, completeJob, prioritize, failInFlight, retryFailed, onUpdate, notify, thumbPath: (id) => path.join(thumbDir, id + '.png') };
