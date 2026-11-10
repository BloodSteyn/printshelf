// Brings new models into the library: direct downloads by URL, local files an
// agent hands over, and browser downloads that land in the watched inbox folder.
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const db = require('./db');
const scanner = require('./scanner');
const { kindOf, PRIMARY_KINDS } = require('./formats');

const MAX_BYTES = 8 * 1024 ** 3;
const UA = 'Mozilla/5.0 (compatible; model-library/0.1)';

const safe = (s) => String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 90) || 'untitled';

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

function importRoot() {
  const dir = db.getSettings().importDir;
  if (!dir) throw new Error('Import folder is not set (Settings).');
  return dir;
}

function applyMeta(id, m = {}) {
  if (!id) return;
  const cur = db.get('SELECT creator, license, source_url, notes FROM files WHERE id = ?', id);
  if (!cur) return;
  db.run('UPDATE files SET creator = ?, license = ?, source_url = ?, notes = ? WHERE id = ?',
    m.creator || cur.creator, m.license || cur.license, m.source_url || m.url || cur.source_url, m.notes || cur.notes, id);
  if (Array.isArray(m.tags) && m.tags.length) db.addTags([id], m.tags);
  if (m.collection) db.addToCollection(m.collection, [id]);
}

function pageMeta(html, url) {
  const pick = (re) => { const m = html.match(re); return m ? m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : ''; };
  const og = (p) => pick(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)["']`, 'i'))
    || pick(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${p}["']`, 'i'));
  return {
    title: og('og:title') || pick(/<title[^>]*>([^<]+)<\/title>/i),
    description: (og('og:description') || og('description')).slice(0, 500),
    creator: og('author') || og('article:author'),
    site: og('og:site_name') || new URL(url).hostname.replace(/^www\./, ''),
  };
}

function filenameFrom(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i);
  const plain = cd.match(/filename\s*=\s*"?([^";]+)"?/i);
  let name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1].trim() : '';
  if (!name) { try { name = decodeURIComponent(path.posix.basename(new URL(res.url || url).pathname)); } catch { name = ''; } }
  return safe(name);
}

async function importFromUrl(args) {
  const url = String(args.url || '');
  let u;
  try { u = new URL(url); } catch { throw new Error('Not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be imported');
  const host = u.hostname.replace(/^www\./, '');

  let res;
  try { res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(30000) }); }
  catch (e) { throw new Error(`Could not reach ${u.host}: ${e.cause?.code || e.message}`); }

  const type = res ? (res.headers.get('content-type') || '') : '';
  const fname = res && res.ok ? filenameFrom(res, url) : '';
  const isFile = res && res.ok && kindOf(fname) && !/text\/html/i.test(type);

  if (!isFile) {
    // A page, a login wall or a bot check: remember what we know and wait for the
    // file to arrive through the browser.
    let meta = { site: host };
    if (res && res.ok && /text\/html/i.test(type)) {
      try { meta = pageMeta((await res.text()).slice(0, 600000), url); } catch { /* keep host only */ }
    } else if (res) { try { await res.body?.cancel(); } catch { /* ignore */ } }
    const stored = { ...meta, title: args.name || meta.title, creator: args.creator || meta.creator, license: args.license, tags: args.tags, collection: args.collection, notes: args.notes, source_url: url };
    const r = db.run('INSERT INTO pending_imports(url, meta, created_at) VALUES(?, ?, ?)', url, JSON.stringify(stored), Date.now());
    const s = db.getSettings();
    return {
      status: 'waiting_for_download',
      pending_id: Number(r.lastInsertRowid),
      page: { title: stored.title, creator: stored.creator, site: meta.site },
      inbox_folder: s.inboxDir,
      next_step: `This URL is a web page (or needs a signed-in session), so the file cannot be fetched directly. Download the model in the user's signed-in browser so it lands in "${s.inboxDir}". The app will pick up the next model or archive that arrives there within ${s.inboxWindowMin} minutes, move it into the library and attach this page's details. Alternatively call import_file with the downloaded file's path and pending_id.`,
    };
  }

  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) { await res.body.cancel(); throw new Error('File is larger than the 8 GB import limit'); }
  const title = safe(args.name || fname.replace(/\.[^.]+$/, ''));
  const dir = path.join(importRoot(), safe(host), title);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = uniquePath(dir, fname);
  let got = 0;
  const counter = new (require('node:stream').Transform)({
    transform(chunk, _e, cb) { got += chunk.length; cb(got > MAX_BYTES ? new Error('Download exceeded the import limit') : null, chunk); },
  });
  try { await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest + '.part')); }
  catch (e) { await fs.promises.unlink(dest + '.part').catch(() => {}); throw e; }
  await fs.promises.rename(dest + '.part', dest);
  const id = await scanner.indexFile(dest);
  applyMeta(id, { ...args, source_url: url });
  return { status: 'imported', id, path: dest, bytes: got };
}

async function storeLocal(src, meta, { move = false, site = 'Imported' } = {}) {
  const name = path.basename(src);
  if (!kindOf(name)) throw new Error('Not a supported model, archive or companion file: ' + name);
  const title = safe(meta.title || meta.name || name.replace(/\.[^.]+$/, ''));
  const dir = path.join(importRoot(), safe(site), title);
  await fs.promises.mkdir(dir, { recursive: true });
  const dest = uniquePath(dir, name);
  if (move) {
    try { await fs.promises.rename(src, dest); }
    catch { await fs.promises.copyFile(src, dest); await fs.promises.unlink(src).catch(() => {}); }
  } else await fs.promises.copyFile(src, dest);
  const id = await scanner.indexFile(dest);
  applyMeta(id, meta);
  return { id, path: dest };
}

async function importFile(args) {
  const src = path.resolve(String(args.path || ''));
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw new Error('File not found: ' + src);
  let meta = { ...args };
  let site = 'Imported';
  if (args.pending_id) {
    const p = db.get('SELECT * FROM pending_imports WHERE id = ?', args.pending_id);
    if (p) {
      const pm = JSON.parse(p.meta);
      meta = { ...pm, ...Object.fromEntries(Object.entries(args).filter(([, v]) => v != null && v !== '')) };
      site = pm.site || site;
      db.run(`UPDATE pending_imports SET status = 'done' WHERE id = ?`, p.id);
    }
  } else if (args.source_url) { try { site = new URL(args.source_url).hostname.replace(/^www\./, ''); } catch { /* keep */ } }
  const r = await storeLocal(src, meta, { move: !!args.move, site });
  return { status: 'imported', ...r };
}

// ---------- watchers ----------
let inboxWatcher = null;
const settling = new Set();
const sourceWatchers = new Map();
let onImported = () => {};

function activePending() {
  const windowMs = db.getSettings().inboxWindowMin * 60000;
  return db.get(`SELECT * FROM pending_imports WHERE status = 'waiting' AND created_at > ? ORDER BY created_at DESC LIMIT 1`, Date.now() - windowMs);
}

async function settle(file) {
  // wait until the browser has finished writing
  let last = -1;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    let st;
    try { st = await fs.promises.stat(file); } catch { return false; }
    if (st.size > 0 && st.size === last) {
      try { const fh = await fs.promises.open(file, 'r+'); await fh.close(); return true; } catch { /* still locked */ }
    }
    last = st.size;
  }
  return false;
}

function watchInbox() {
  if (inboxWatcher) { inboxWatcher.close(); inboxWatcher = null; }
  const dir = db.getSettings().inboxDir;
  if (!dir || !fs.existsSync(dir)) return;
  try {
    inboxWatcher = fs.watch(dir, { persistent: false }, async (_ev, name) => {
      if (!name) return;
      const k = kindOf(name);
      if (!k || !(PRIMARY_KINDS.has(k) || k === 'archive')) return;
      const full = path.join(dir, name);
      if (settling.has(full) || !activePending()) return;
      settling.add(full);
      try {
        if (!(await settle(full))) return;
        const p = activePending();
        if (!p) return;
        const meta = JSON.parse(p.meta);
        db.run(`UPDATE pending_imports SET status = 'done' WHERE id = ?`, p.id);
        const r = await storeLocal(full, meta, { move: true, site: meta.site || 'Imported' });
        onImported({ ...r, title: meta.title });
      } catch (e) { onImported({ error: e.message }); }
      finally { settling.delete(full); }
    });
  } catch { /* folder not watchable */ }
}

function watchSources() {
  const wanted = new Map(db.all('SELECT * FROM sources WHERE paused = 0').map((s) => [s.id, s]));
  for (const [id, w] of sourceWatchers) if (!wanted.has(id)) { w.close(); sourceWatchers.delete(id); }
  for (const [id, s] of wanted) {
    if (sourceWatchers.has(id) || !fs.existsSync(s.path)) continue;
    let timer = null;
    try {
      const w = fs.watch(s.path, { recursive: true, persistent: false }, (_e, name) => {
        if (name && !kindOf(String(name)) && String(name).includes('.')) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          const cur = db.get('SELECT * FROM sources WHERE id = ?', id);
          if (cur && !cur.paused) scanner.scanSource(cur).then(() => scanner.hashPending());
        }, 6000);
      });
      w.on('error', () => { sourceWatchers.delete(id); });
      sourceWatchers.set(id, w);
    } catch { /* not watchable (network share, etc.) */ }
  }
}

module.exports = {
  importFromUrl, importFile, applyMeta, watchInbox, watchSources,
  onImported: (fn) => { onImported = fn; },
  listPending: () => db.all(`SELECT id, url, meta, created_at, status FROM pending_imports ORDER BY id DESC LIMIT 30`).map((p) => ({ ...p, meta: JSON.parse(p.meta) })),
  cancelPending: (id) => db.run(`UPDATE pending_imports SET status = 'cancelled' WHERE id = ?`, id),
};
