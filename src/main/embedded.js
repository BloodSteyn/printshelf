// Pulls what slicers already embed in a file: preview pictures and print settings.
// 3MF projects, G-code, binary G-code and LightBurn projects are handled here in
// the main process; everything else is rendered by the hidden worker window.
const fs = require('node:fs');
const archives = require('./archives');

async function readHead(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally { await fh.close(); }
}
async function readTail(file, bytes) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const n = Math.min(bytes, size);
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, size - n);
    return buf;
  } finally { await fh.close(); }
}

function slicerName(app) {
  const a = (app || '').toLowerCase();
  if (a.includes('bambu')) return 'Bambu Studio';
  if (a.includes('orca')) return 'OrcaSlicer';
  if (a.includes('prusa')) return 'PrusaSlicer';
  if (a.includes('superslicer')) return 'SuperSlicer';
  if (a.includes('cura')) return 'Cura';
  if (a.includes('creality')) return 'Creality Print';
  if (a.includes('anycubic')) return 'Anycubic Slicer';
  if (a.includes('elegoo')) return 'ElegooSlicer';
  if (a.includes('qidi')) return 'QIDI Studio';
  if (a.includes('simplify3d')) return 'Simplify3D';
  if (a.includes('ideamaker')) return 'ideaMaker';
  return '';
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

async function from3mf(file) {
  const meta = {};
  const tags = [];
  let thumb = null;
  const entries = await archives.listZip(file);
  const names = entries.map((e) => e.name);
  const lower = new Map(names.map((n) => [n.toLowerCase().replace(/^\//, ''), n]));

  const plates = names.filter((n) => /^\/?Metadata\/plate_\d+\.png$/i.test(n)).length;
  if (plates) meta.plates = plates;

  const pick = ['metadata/plate_1.png', 'metadata/thumbnail.png', 'thumbnails/thumbnail.png', 'metadata/thumbnail.jpg', 'thumbnails/thumbnail.jpg']
    .map((n) => lower.get(n)).find(Boolean)
    || names.find((n) => /^\/?Metadata\/plate_\d+\.png$/i.test(n))
    || names.find((n) => /^\/?(Thumbnails|Metadata)\/[^/]*\.(png|jpe?g)$/i.test(n) && !/small|no_light|top_|pick_/i.test(n));
  if (pick) thumb = await archives.zipEntryBuffer(file, pick, 16 << 20);

  const modelName = lower.get('3d/3dmodel.model');
  if (modelName) {
    const head = (await archives.zipEntryBuffer(file, modelName, 256 * 1024)).toString('utf8');
    const md = (k) => (head.match(new RegExp(`<metadata[^>]*name="${k}"[^>]*>([^<]*)<`, 'i')) || [])[1];
    const app = md('Application');
    if (app) { meta.application = app.trim(); meta.slicer = slicerName(app); }
    for (const [k, to] of [['Title', 'title'], ['Designer', 'designer'], ['License', 'license'], ['Description', 'description']]) {
      const v = md(k);
      if (v && v.trim()) meta[to] = v.trim().slice(0, 500);
    }
    const unit = (head.match(/<model[^>]*unit="(\w+)"/) || [])[1];
    if (unit) meta.unit = unit;
  }

  const proj = lower.get('metadata/project_settings.config');
  if (proj) {
    try {
      const j = JSON.parse((await archives.zipEntryBuffer(file, proj, 8 << 20)).toString('utf8'));
      meta.printer = first(j.printer_model) || first(j.printer_settings_id) || undefined;
      meta.nozzle = first(j.nozzle_diameter) || undefined;
      meta.profile = first(j.print_settings_id) || first(j.default_print_profile) || undefined;
      meta.layerHeight = first(j.layer_height) || undefined;
      meta.bed = first(j.curr_bed_type) || undefined;
      if (Array.isArray(j.filament_colour)) meta.filamentColors = j.filament_colour.slice(0, 16);
      if (Array.isArray(j.filament_type)) meta.filamentTypes = j.filament_type.slice(0, 16);
      if (!meta.slicer) meta.slicer = 'Bambu Studio';
    } catch { /* not JSON: older or foreign project */ }
  }
  const prusa = lower.get('metadata/slic3r_pe.config');
  if (prusa) {
    const t = (await archives.zipEntryBuffer(file, prusa, 2 << 20)).toString('utf8');
    const g = (k) => (t.match(new RegExp(`^; ${k} = (.*)$`, 'm')) || [])[1];
    meta.printer = meta.printer || g('printer_model');
    meta.nozzle = meta.nozzle || (g('nozzle_diameter') || '').split(',')[0] || undefined;
    meta.layerHeight = meta.layerHeight || g('layer_height');
    const cols = g('extruder_colour') || g('filament_colour');
    if (cols && !meta.filamentColors) meta.filamentColors = cols.split(';').filter(Boolean);
    if (!meta.slicer) meta.slicer = 'PrusaSlicer';
  }
  const slice = lower.get('metadata/slice_info.config');
  let usedFilaments = 0;
  if (slice) {
    const t = (await archives.zipEntryBuffer(file, slice, 2 << 20)).toString('utf8');
    usedFilaments = new Set([...t.matchAll(/<filament\s+id="(\d+)"/g)].map((m) => m[1])).size;
    const pred = [...t.matchAll(/key="prediction"\s+value="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
    const weight = [...t.matchAll(/key="weight"\s+value="([\d.]+)"/g)].reduce((a, m) => a + Number(m[1]), 0);
    if (pred) meta.printSeconds = pred;
    if (weight) meta.filamentGrams = Math.round(weight * 10) / 10;
  }
  const distinct = new Set((meta.filamentColors || []).map((c) => String(c).toLowerCase())).size;
  if (usedFilaments > 1 || (!usedFilaments && distinct > 1)) tags.push('Multi-color');
  if (meta.slicer) tags.push(meta.slicer);
  for (const k of Object.keys(meta)) if (meta[k] === undefined || meta[k] === '') delete meta[k];
  return { thumb, meta, tags };
}

function gcodeMeta(text) {
  const meta = {};
  const g = (re) => (text.match(re) || [])[1];
  const gen = g(/^; generated by ([^\n\r]+)/m) || g(/^; (BambuStudio[^\n\r]*)/m) || g(/^;Generated with (Cura[^\n\r]*)/m) || g(/^; (OrcaSlicer[^\n\r]*)/m);
  if (gen) { meta.application = gen.trim().slice(0, 80); meta.slicer = slicerName(gen); }
  meta.printer = g(/^; printer_model = (.+)$/m);
  meta.nozzle = (g(/^; nozzle_diameter = (.+)$/m) || '').split(',')[0] || undefined;
  meta.layerHeight = g(/^; layer_height = (.+)$/m);
  meta.printTime = g(/^; estimated printing time \(normal mode\) = (.+)$/m) || g(/^; model printing time: ([^;\n\r]+)/m) || g(/^;TIME:(\d+)/m);
  const grams = g(/^; (?:total )?filament used \[g\] = ([\d.]+)/m);
  if (grams) meta.filamentGrams = Number(grams);
  for (const k of Object.keys(meta)) if (meta[k] === undefined || meta[k] === '') delete meta[k];
  return meta;
}

async function fromGcode(file) {
  const head = (await readHead(file, 1 << 20)).toString('latin1');
  const tail = (await readTail(file, 256 * 1024)).toString('latin1');
  let best = null;
  const re = /; thumbnail(?:_(PNG|JPG|QOI))? begin (\d+)x(\d+) \d+\r?\n([\s\S]*?); thumbnail(?:_\w+)? end/g;
  for (const src of [head, tail]) {
    for (const m of src.matchAll(re)) {
      if (m[1] === 'QOI') continue;
      const area = Number(m[2]) * Number(m[3]);
      if (!best || area > best.area) best = { area, b64: m[4].replace(/^; ?/gm, '').replace(/\s+/g, '') };
    }
  }
  const meta = gcodeMeta(head + '\n' + tail);
  return { thumb: best ? Buffer.from(best.b64, 'base64') : null, meta, tags: meta.slicer ? [meta.slicer] : [] };
}

async function fromBgcode(file) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const hdr = Buffer.alloc(10);
    await fh.read(hdr, 0, 10, 0);
    if (hdr.toString('latin1', 0, 4) !== 'GCDE') return { thumb: null, meta: {}, tags: [] };
    const checksum = hdr.readUInt16LE(8);
    let pos = 10;
    let best = null;
    let metaText = '';
    for (let i = 0; i < 64; i++) {
      const bh = Buffer.alloc(12);
      const { bytesRead } = await fh.read(bh, 0, 12, pos);
      if (bytesRead < 8) break;
      const type = bh.readUInt16LE(0);
      const comp = bh.readUInt16LE(2);
      const usize = bh.readUInt32LE(4);
      const hlen = comp ? 12 : 8;
      const dsize = comp ? bh.readUInt32LE(8) : usize;
      const plen = type === 5 ? 6 : 2;
      if (type === 1 || type > 5) break; // G-code blocks start: nothing more to find
      if (type === 5 && dsize < (16 << 20)) {
        const p = Buffer.alloc(6);
        await fh.read(p, 0, 6, pos + hlen);
        const fmt = p.readUInt16LE(0), area = p.readUInt16LE(2) * p.readUInt16LE(4);
        if (fmt !== 2 && (!best || area > best.area)) {
          const data = Buffer.alloc(dsize);
          await fh.read(data, 0, dsize, pos + hlen + plen);
          best = { area, data };
        }
      } else if (!comp && dsize < (1 << 20)) {
        const data = Buffer.alloc(dsize);
        await fh.read(data, 0, dsize, pos + hlen + plen);
        metaText += data.toString('latin1') + '\n';
      }
      pos += hlen + plen + dsize + (checksum === 1 ? 4 : 0);
    }
    const kv = (k) => (metaText.match(new RegExp(`^${k}=(.*)$`, 'm')) || [])[1];
    const meta = {};
    const producer = kv('Producer');
    if (producer) { meta.application = producer; meta.slicer = slicerName(producer); }
    if (kv('printer_model')) meta.printer = kv('printer_model');
    if (kv('nozzle_diameter')) meta.nozzle = kv('nozzle_diameter').split(',')[0];
    if (kv('estimated printing time \\(normal mode\\)')) meta.printTime = kv('estimated printing time \\(normal mode\\)');
    if (kv('filament used \\[g\\]')) meta.filamentGrams = Number(kv('filament used \\[g\\]'));
    return { thumb: best ? best.data : null, meta, tags: meta.slicer ? [meta.slicer] : [] };
  } finally { await fh.close(); }
}

async function fromLightburn(file) {
  const head = (await readHead(file, 4 << 20)).toString('latin1');
  const m = head.match(/<Thumbnail\s+Source="([^"]+)"/);
  return { thumb: m ? Buffer.from(m[1], 'base64') : null, meta: { application: 'LightBurn' }, tags: [] };
}

/** Returns { thumb: Buffer|null, meta, tags } or null when this type has nothing embedded. */
async function extract(localPath, ext) {
  if (ext === '3mf') return from3mf(localPath);
  if (ext === 'gcode' || ext === 'gco') return fromGcode(localPath);
  if (ext === 'bgcode') return fromBgcode(localPath);
  if (ext === 'lbrn' || ext === 'lbrn2') return fromLightburn(localPath);
  return null;
}

module.exports = { extract, HANDLED: new Set(['3mf', 'gcode', 'gco', 'bgcode', 'lbrn', 'lbrn2']) };
