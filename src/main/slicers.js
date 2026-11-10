// Finds installed slicers and hands a model to the one you pick.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('./db');

const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PF86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LOCAL = process.env.LOCALAPPDATA || '';

const KNOWN = [
  ['Bambu Studio', [`${PF}\\Bambu Studio\\bambu-studio.exe`]],
  ['OrcaSlicer', [`${PF}\\OrcaSlicer\\orca-slicer.exe`, `${LOCAL}\\Programs\\OrcaSlicer\\orca-slicer.exe`]],
  ['PrusaSlicer', [`${PF}\\Prusa3D\\PrusaSlicer\\prusa-slicer.exe`, `${PF}\\PrusaSlicer\\prusa-slicer.exe`]],
  ['SuperSlicer', [`${PF}\\SuperSlicer\\superslicer.exe`]],
  ['UltiMaker Cura', []],
  ['Creality Print', []],
  ['Anycubic Slicer Next', [`${PF}\\AnycubicSlicerNext\\AnycubicSlicerNext.exe`]],
  ['ElegooSlicer', [`${PF}\\ElegooSlicer\\elegoo-slicer.exe`]],
  ['QIDI Studio', [`${PF}\\QIDIStudio\\qidi-studio.exe`, `${PF}\\QIDI Studio\\qidi-studio.exe`]],
  ['FlashPrint', [`${PF}\\FlashForge\\FlashPrint 5\\FlashPrint.exe`, `${PF}\\FlashForge\\FlashPrint\\FlashPrint.exe`]],
  ['ideaMaker', [`${PF}\\Raise3D\\ideaMaker\\ideaMaker.exe`]],
  ['Simplify3D', [`${PF}\\Simplify3D\\Simplify3D.exe`]],
  ['Lychee Slicer', [`${LOCAL}\\Programs\\LycheeSlicer\\LycheeSlicer.exe`, `${PF}\\LycheeSlicer\\LycheeSlicer.exe`]],
  ['CHITUBOX', [`${PF}\\CHITUBOX\\CHITUBOX.exe`]],
  ['Anycubic Photon Workshop', []],
  ['UVtools', [`${PF}\\UVtools\\UVtools.exe`]],
  ['Snapmaker Luban', [`${PF}\\Snapmaker Luban\\Snapmaker Luban.exe`]],
  ['Blender', []],
];

// Slicers that install into versioned folders: scan Program Files for a match.
const VERSIONED = [
  ['UltiMaker Cura', /^(ultimaker|ultimaker cura|cura)/i, ['UltiMaker-Cura.exe', 'Ultimaker-Cura.exe', 'Cura.exe']],
  ['Creality Print', /^creality/i, ['CrealityPrint.exe', 'Creality Print.exe']],
  ['Anycubic Photon Workshop', /^anycubic photon/i, ['AnycubicPhotonWorkshop.exe']],
  ['Blender', /^blender foundation$/i, null],
];

function scanVersioned() {
  const found = {};
  for (const base of [PF, PF86]) {
    let dirs = [];
    try { dirs = fs.readdirSync(base); } catch { continue; }
    for (const [name, re, exes] of VERSIONED) {
      if (found[name]) continue;
      for (const d of dirs.filter((x) => re.test(x)).sort().reverse()) {
        const root = path.join(base, d);
        if (exes) {
          const hit = exes.map((e) => path.join(root, e)).find((p) => fs.existsSync(p));
          if (hit) { found[name] = hit; break; }
          try {
            for (const sub of fs.readdirSync(root).sort().reverse()) {
              const h2 = exes.map((e) => path.join(root, sub, e)).find((p) => fs.existsSync(p));
              if (h2) { found[name] = h2; break; }
            }
          } catch { /* unreadable */ }
        } else {
          try {
            for (const sub of fs.readdirSync(root).sort().reverse()) {
              const p = path.join(root, sub, 'blender.exe');
              if (fs.existsSync(p)) { found[name] = p; break; }
            }
          } catch { /* unreadable */ }
        }
        if (found[name]) break;
      }
    }
  }
  return found;
}

let cache = null;
function detect(force) {
  if (cache && !force) return cache;
  const overrides = db.getSettings().slicerPaths || {};
  const versioned = process.platform === 'win32' ? scanVersioned() : {};
  const out = [];
  for (const [name, paths] of KNOWN) {
    const exe = [overrides[name], ...paths, versioned[name]].filter(Boolean).find((p) => fs.existsSync(p));
    if (exe) out.push({ name, exe });
  }
  for (const [name, exe] of Object.entries(overrides)) {
    if (!out.some((s) => s.name === name) && exe && fs.existsSync(exe)) out.push({ name, exe });
  }
  cache = out;
  return out;
}

function open(slicerName, filePaths) {
  const list = detect();
  const s = list.find((x) => x.name === slicerName) || list.find((x) => x.name === db.getSettings().defaultSlicer) || list[0];
  if (!s) throw new Error('No slicer found. Add one in Settings.');
  spawn(s.exe, filePaths, { detached: true, stdio: 'ignore' }).unref();
  return s.name;
}

module.exports = { detect, open };
