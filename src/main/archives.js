// Read archives like folders: list entries and pull single entries out
// without unpacking the rest. ZIP and TAR are read natively; 7z and RAR go
// through 7-Zip (the installed one if present, else the bundled 7za).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { extOf } = require('./formats');

function sevenZipExe() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    '/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    return require('7zip-bin').path7za.replace('app.asar', 'app.asar.unpacked');
  } catch { return null; }
}

function openZip(file) {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

async function listZip(file) {
  const zip = await openZip(file);
  return new Promise((resolve, reject) => {
    const out = [];
    zip.on('entry', (e) => {
      if (!e.fileName.endsWith('/')) out.push({ name: e.fileName, size: e.uncompressedSize, crc: e.crc32 >>> 0 });
      zip.readEntry();
    });
    zip.on('end', () => { zip.close(); resolve(out); });
    zip.on('error', (e) => { zip.close(); reject(e); });
    zip.readEntry();
  });
}

/** Stream one ZIP entry. `want` is an entry name or a predicate. Resolves null if absent. */
async function zipEntryStream(file, want) {
  const zip = await openZip(file);
  const match = typeof want === 'function' ? want : (n) => n === want;
  return new Promise((resolve, reject) => {
    zip.on('entry', (e) => {
      if (!match(e.fileName)) return zip.readEntry();
      zip.openReadStream(e, (err, stream) => {
        if (err) { zip.close(); return reject(err); }
        stream.on('end', () => zip.close());
        stream.on('error', () => zip.close());
        resolve({ stream, entry: e, close: () => zip.close() });
      });
    });
    zip.on('end', () => { zip.close(); resolve(null); });
    zip.on('error', (e) => { zip.close(); reject(e); });
    zip.readEntry();
  });
}

async function zipEntryBuffer(file, want, maxBytes = 64 * 1024 * 1024) {
  const r = await zipEntryStream(file, want);
  if (!r) return null;
  const chunks = [];
  let n = 0;
  for await (const c of r.stream) {
    chunks.push(c);
    n += c.length;
    if (n >= maxBytes) { r.stream.destroy(); r.close(); break; }
  }
  return Buffer.concat(chunks);
}

// ---------- tar ----------
function tarSource(file) {
  const raw = fs.createReadStream(file);
  return /\.(tgz|gz)$/i.test(file) ? raw.pipe(zlib.createGunzip()) : raw;
}

/** Walk a tar stream. onEntry(name, size) may return a writable to receive that entry's bytes. */
async function walkTar(file, onEntry) {
  const src = tarSource(file);
  let buf = Buffer.alloc(0);
  let remaining = 0, pad = 0, sink = null, longName = null, collectLong = null, stop = false;
  for await (const chunk of src) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length && !stop) {
      if (remaining > 0) {
        const take = Math.min(remaining, buf.length);
        const part = buf.subarray(0, take);
        if (collectLong) collectLong.push(part);
        else if (sink && !sink.write(part)) await new Promise((r) => sink.once('drain', r));
        buf = buf.subarray(take);
        remaining -= take;
        if (remaining === 0) {
          if (collectLong) { longName = Buffer.concat(collectLong).toString('utf8').replace(/\0.*$/s, ''); collectLong = null; }
          if (sink) { await new Promise((r) => sink.end(r)); sink = null; stop = true; }
        }
        continue;
      }
      if (pad > 0) { const t = Math.min(pad, buf.length); buf = buf.subarray(t); pad -= t; continue; }
      if (buf.length < 512) break;
      const h = buf.subarray(0, 512);
      buf = buf.subarray(512);
      if (h.every((b) => b === 0)) continue;
      const str = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
      const size = parseInt(str(124, 136).trim() || '0', 8) || 0;
      const type = String.fromCharCode(h[156] || 48);
      let name = str(0, 100);
      const prefix = str(345, 500);
      if (prefix && str(257, 262) === 'ustar') name = prefix + '/' + name;
      remaining = size;
      pad = (512 - (size % 512)) % 512;
      if (type === 'L') { collectLong = []; continue; }
      if (longName) { name = longName; longName = null; }
      if (type === '0' || type === '\0') sink = onEntry(name, size) || null;
      if (size === 0 && sink) { await new Promise((r) => sink.end(r)); sink = null; stop = true; }
    }
    if (stop) { src.destroy(); break; }
  }
}

async function listTar(file) {
  const out = [];
  await walkTar(file, (name, size) => { out.push({ name, size, crc: null }); return null; });
  return out;
}

// ---------- 7z / rar ----------
function run7z(args, outStream) {
  return new Promise((resolve, reject) => {
    const exe = sevenZipExe();
    if (!exe) return reject(new Error('7-Zip not available'));
    const p = spawn(exe, args, { windowsHide: true });
    let out = '', err = '';
    if (outStream) p.stdout.pipe(outStream);
    else p.stdout.on('data', (d) => { if (out.length < 64 * 1024 * 1024) out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `7z exited ${code}`))));
  });
}

async function list7z(file) {
  const text = await run7z(['l', '-slt', '-ba', '-sccUTF-8', '-p', file]);
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const m = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i > 0) m[line.slice(0, i)] = line.slice(i + 3);
    }
    if (!m.Path || m.Folder === '+' || (m.Attributes || '').startsWith('D')) continue;
    out.push({ name: m.Path.replace(/\\/g, '/'), size: Number(m.Size) || 0, crc: m.CRC ? parseInt(m.CRC, 16) >>> 0 : null });
  }
  return out;
}

// ---------- public ----------
function archiveType(file) {
  const e = extOf(file);
  if (e === 'zip') return 'zip';
  if (e === 'tar' || e === 'tgz') return 'tar';
  if (e === '7z' || e === 'rar') return '7z';
  return null; // bare .gz is indexed but not opened
}

async function listEntries(file) {
  const t = archiveType(file);
  if (t === 'zip') return listZip(file);
  if (t === 'tar') return listTar(file);
  if (t === '7z') return list7z(file);
  return [];
}

async function extractEntry(file, entryName, dest) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const t = archiveType(file);
  if (t === 'zip') {
    const r = await zipEntryStream(file, entryName);
    if (!r) throw new Error('Entry not found: ' + entryName);
    await pipeline(r.stream, fs.createWriteStream(tmp));
  } else if (t === 'tar') {
    let found = false;
    await walkTar(file, (name) => (name === entryName ? ((found = true), fs.createWriteStream(tmp)) : null));
    if (!found) throw new Error('Entry not found: ' + entryName);
  } else if (t === '7z') {
    const ws = fs.createWriteStream(tmp);
    await run7z(['e', '-so', '-p', file, entryName.replace(/\//g, path.sep)], ws);
    await new Promise((r) => (ws.writableFinished ? r() : ws.once('finish', r)));
  } else throw new Error('Unsupported archive');
  await fs.promises.rename(tmp, dest);
  return dest;
}

module.exports = { listEntries, extractEntry, zipEntryBuffer, zipEntryStream, listZip, archiveType, sevenZipExe };
