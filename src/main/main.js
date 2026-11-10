const { app, BrowserWindow, ipcMain, protocol, net, dialog, shell, nativeImage, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

if (process.env.PRINTSHELF_DATA) app.setPath('userData', path.resolve(process.env.PRINTSHELF_DATA));
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const db = require('./db');
const scanner = require('./scanner');
const jobs = require('./jobs');
const importer = require('./importer');
const slicers = require('./slicers');
const api = require('./api');
const { agent, ui } = require('./tools');

protocol.registerSchemesAsPrivileged([
  { scheme: 'lib', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const RENDERER = path.join(__dirname, '..', 'renderer');
const MODULES = path.join(__dirname, '..', '..', 'node_modules');
let win = null;
let worker = null;
let watchdog = null;

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };
const wakeWorker = () => { if (worker && !worker.isDestroyed()) worker.webContents.send('worker-wake'); };

function inside(root, p) {
  const rel = path.relative(root, p);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function handleLib(request) {
  const url = new URL(request.url);
  const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
  const [area, ...rest] = parts;
  try {
    if (area === 'app') {
      const p = path.join(RENDERER, ...rest);
      if (!inside(RENDERER, p)) return new Response('', { status: 403 });
      return net.fetch(pathToFileURL(p).toString());
    }
    if (area === 'vendor') {
      const allowed = ['three', 'fflate'];
      if (!allowed.includes(rest[0])) return new Response('', { status: 403 });
      const p = path.join(MODULES, ...rest);
      if (!inside(MODULES, p)) return new Response('', { status: 403 });
      return net.fetch(pathToFileURL(p).toString());
    }
    if (area === 'thumb') {
      const buf = await fs.promises.readFile(jobs.thumbPath(Number(rest[0])));
      const type = buf[0] === 0xff && buf[1] === 0xd8 ? 'image/jpeg' : 'image/png';
      return new Response(buf, { headers: { 'content-type': type, 'cache-control': 'max-age=31536000' } });
    }
    if (area === 'file') {
      const f = db.get('SELECT * FROM files WHERE id = ?', Number(rest[0]));
      if (!f) return new Response('', { status: 404 });
      const local = await scanner.resolveLocalPath(f);
      return net.fetch(pathToFileURL(local).toString(), { headers: request.headers });
    }
  } catch (e) {
    return new Response(String(e.message), { status: 500 });
  }
  return new Response('', { status: 404 });
}

function createWindows() {
  const prefs = { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false };
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 620, backgroundColor: '#14161a', show: false,
    title: 'Printshelf', autoHideMenuBar: true, webPreferences: prefs,
  });
  win.loadURL('lib://x/app/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('lib://x/app/')) e.preventDefault(); });
  win.on('closed', () => { win = null; if (worker && !worker.isDestroyed()) worker.destroy(); });

  worker = new BrowserWindow({ width: 640, height: 640, show: false, webPreferences: { ...prefs, offscreen: false } });
  worker.loadURL('lib://x/app/worker.html');
  worker.webContents.on('render-process-gone', () => {
    jobs.failInFlight('worker crashed');
    setTimeout(() => { if (worker && !worker.isDestroyed()) worker.reload(); }, 500);
  });

  if (process.env.PRINTSHELF_SHOT) {
    const shoot = async () => {
      const img = await win.webContents.capturePage();
      await fs.promises.writeFile(process.env.PRINTSHELF_SHOT, img.toPNG());
    };
    ipcMain.handle('dev:shot', shoot);
    setTimeout(async () => {
      try {
        if (process.env.PRINTSHELF_EVAL) { await win.webContents.executeJavaScript(process.env.PRINTSHELF_EVAL, true); await new Promise((r) => setTimeout(r, Number(process.env.PRINTSHELF_EVAL_WAIT || 2500))); }
        await shoot();
      } catch (e) { console.log('[shot]', e.message); }
      if (process.env.PRINTSHELF_EXIT) app.quit();
    }, Number(process.env.PRINTSHELF_SHOT_DELAY || 9000));
    win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('[renderer]', e.message); });
    worker.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) console.log('[worker]', e.message); });
  }
}

function firstRun() {
  const s = db.getSettings();
  const patch = {};
  if (!s.importDir) {
    patch.importDir = process.env.PRINTSHELF_DATA ? path.join(app.getPath('userData'), 'Library') : path.join(app.getPath('documents'), 'Printshelf Library');
    fs.mkdirSync(patch.importDir, { recursive: true });
    db.run('INSERT OR IGNORE INTO sources(path, name, added_at) VALUES(?, ?, ?)', patch.importDir, 'Printshelf Library', Date.now());
  }
  if (!s.inboxDir) patch.inboxDir = app.getPath('downloads');
  if (Object.keys(patch).length) db.saveSettings(patch);
  if (process.env.PRINTSHELF_SOURCE) {
    for (const one of process.env.PRINTSHELF_SOURCE.split(';').filter(Boolean)) {
      const p = path.resolve(one);
      db.run('INSERT OR IGNORE INTO sources(path, name, added_at) VALUES(?, ?, ?)', p, path.basename(p), Date.now());
    }
  }
}

async function localPathsFor(ids) {
  const out = [];
  for (const id of ids) {
    const f = db.get('SELECT * FROM files WHERE id = ?', Number(id));
    if (f) out.push(await scanner.resolveLocalPath(f));
  }
  return out;
}

const native = {
  async pick_folder() {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  async pick_exe() {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Programs', extensions: ['exe', 'app', '*'] }] });
    return r.canceled ? null : r.filePaths[0];
  },
  reveal(a) {
    const f = a.id ? db.get('SELECT path, archive_id FROM files WHERE id = ?', a.id) : null;
    let p = f ? f.path : a.path;
    if (!p) return false;
    p = p.split('::')[0];
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) shell.openPath(p); else shell.showItemInFolder(p);
    return true;
  },
  async open_default(a) {
    const [p] = await localPathsFor([a.id]);
    return p ? shell.openPath(p) : 'missing';
  },
  async open_slicer(a) {
    const paths = await localPathsFor(a.ids);
    return slicers.open(a.slicer, paths);
  },
  open_url(a) { if (/^https?:\/\//i.test(a.url)) shell.openExternal(a.url); return true; },
  async trash(a) {
    const rows = (a.ids || []).map((id) => db.get('SELECT id, path, name, archive_id FROM files WHERE id = ?', Number(id))).filter((f) => f && !f.archive_id);
    if (!rows.length) return { trashed: 0 };
    const r = await dialog.showMessageBox(win, {
      type: 'warning', buttons: ['Move to Recycle Bin', 'Cancel'], defaultId: 1, cancelId: 1,
      message: rows.length === 1 ? `Move "${rows[0].name}" to the Recycle Bin?` : `Move ${rows.length} files to the Recycle Bin?`,
      detail: (a.detail ? a.detail + '\n\n' : '') + rows.slice(0, 8).map((f) => f.path).join('\n') + (rows.length > 8 ? `\n…and ${rows.length - 8} more` : ''),
    });
    if (r.response !== 0) return { trashed: 0, cancelled: true };
    let n = 0;
    const failed = [];
    for (const f of rows) {
      try { await shell.trashItem(f.path); db.deleteFileRows([f.id]); n++; }
      catch (e) { failed.push(f.name); }
    }
    send('files-updated', [-1]);
    return { trashed: n, failed };
  },
  mcp_info() {
    return { server: path.join(__dirname, '..', '..', 'mcp', 'server.js'), dataDir: app.getPath('userData') };
  },
};

app.whenReady().then(() => {
  const data = app.getPath('userData');
  const thumbDir = path.join(data, 'thumbs');
  const cacheDir = path.join(data, 'extract-cache');
  fs.mkdirSync(thumbDir, { recursive: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  db.open(path.join(data, 'library.db'));
  scanner.init({ thumbDir, cacheDir });
  jobs.init({ thumbDir });
  firstRun();
  Menu.setApplicationMenu(null);
  protocol.handle('lib', handleLib);

  ipcMain.handle('tool', async (_e, name, args) => {
    const fn = Object.hasOwn(ui, name) ? ui[name] : Object.hasOwn(agent, name) ? agent[name] : null;
    if (!fn) throw new Error('Unknown operation ' + name);
    return fn(args || {});
  });
  ipcMain.handle('native', async (_e, name, args) => {
    if (!Object.hasOwn(native, name)) throw new Error('Unknown operation ' + name);
    return native[name](args || {});
  });
  ipcMain.handle('worker:next', async () => {
    const job = await jobs.nextJob();
    clearTimeout(watchdog);
    if (job) {
      watchdog = setTimeout(() => {
        jobs.failInFlight('timeout');
        if (worker && !worker.isDestroyed()) worker.reload();
      }, 180000);
    }
    return job;
  });
  ipcMain.handle('worker:done', async (_e, id, result) => { clearTimeout(watchdog); await jobs.completeJob(id, result || {}); return true; });
  ipcMain.on('drag', async (e, ids) => {
    try {
      const files = await localPathsFor(ids);
      if (!files.length) return;
      let icon = nativeImage.createFromPath(jobs.thumbPath(Number(ids[0])));
      icon = icon.isEmpty()
        ? nativeImage.createFromBitmap(Buffer.alloc(32 * 32 * 4, 0x90), { width: 32, height: 32 })
        : icon.resize({ width: 72 });
      e.sender.startDrag({ files, file: files[0], icon });
    } catch { /* drag cancelled */ }
  });

  jobs.onUpdate((ids) => send('files-updated', ids));
  scanner.events.on('progress', (p) => send('scan', { ...p, running: true }));
  scanner.events.on('done', (p) => { send('scan', { ...p, running: scanner.isScanning() }); send('files-updated', [-1]); wakeWorker(); });
  importer.onImported((r) => { send('imported', r); wakeWorker(); });

  api.start(data, app.getVersion());
  createWindows();
  importer.watchInbox();
  importer.watchSources();
  scanner.scanAll().then(() => { scanner.hashPending(); wakeWorker(); });
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { fs.unlinkSync(path.join(app.getPath('userData'), 'api.json')); } catch { /* already gone */ } });
