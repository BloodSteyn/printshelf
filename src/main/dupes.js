// Duplicate finder. Checks run cheapest first:
//   bytes (hash) -> mesh (same triangles) -> shape (rotated / rescaled / re-meshed)
//   -> position (same triangles, moved) -> archive vs unpacked -> folders.
// "Certain" groups can be cleaned in bulk; "likely" pairs always wait for a person.
const path = require('node:path');
const db = require('./db');

function keeperScore(f) {
  // Lower is better.
  let s = 0;
  const p = f.path.toLowerCase();
  if (/\(\d+\)|[ _-]copy|kopie|[ _-]kopie|- copy| copy\b/.test(f.name.toLowerCase())) s += 50;
  if (/[\\/](downloads?|temp|tmp|desktop)[\\/]/.test(p)) s += 20;
  if (f.favorite) s -= 100;
  if (f.tagCount) s -= 10;
  if (f.ext === '3mf') s -= 3; // project files carry settings and colours
  s += Math.min(p.length, 400) / 100;
  return s;
}
function keeperReason(k, others) {
  if (k.favorite) return 'it is a favourite';
  if (k.tagCount) return 'it carries your tags';
  if (others.some((o) => /\(\d+\)|copy|kopie/i.test(o.name)) && !/\(\d+\)|copy|kopie/i.test(k.name)) return 'it has the original name';
  if (others.some((o) => /[\\/](downloads?|temp|tmp|desktop)[\\/]/i.test(o.path))) return 'it sits in your library, not a downloads folder';
  return 'it has the shortest path';
}

const close = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(Math.abs(a), Math.abs(b), 1e-9);
// signature = [minx,miny,minz,maxx,maxy,maxz,area,volume,cx,cy,cz]; text formats round
// coordinates, so compare with a small tolerance instead of hashing.
function sameMesh(a, b) {
  const span = Math.max(a[3] - a[0], a[4] - a[1], a[5] - a[2], 1e-6);
  for (let i = 0; i < 6; i++) if (Math.abs(a[i] - b[i]) > span * 2e-5) return false;
  for (let i = 8; i < 11; i++) if (Math.abs(a[i] - b[i]) > span * 2e-5) return false;
  return close(a[6], b[6], 5e-5) && close(a[7], b[7], 5e-5);
}
const compactness = (f) => (f.volume > 1e-9 && f.area > 0 ? Math.pow(f.area, 1.5) / f.volume : 0);

function find() {
  const files = db.all(`SELECT f.id, f.name, f.path, f.dir, f.ext, f.kind, f.size, f.mtime, f.hash, f.mesh_hash, f.moved_hash, f.tri_count,
      f.bx, f.by, f.bz, f.volume, f.area, f.favorite, f.thumb_state, f.thumb_ver,
      (SELECT COUNT(*) FROM file_tags ft JOIN tags t ON t.id = ft.tag_id WHERE ft.file_id = f.id AND t.auto = 0) AS tagCount
    FROM files f WHERE f.archive_id IS NULL AND f.kind IN ('model','cad','gcode','laser','archive') AND f.hash IS NOT NULL AND f.hash NOT LIKE 'unreadable:%'`);
  const byId = new Map(files.map((f) => [f.id, f]));
  const decisions = new Map(db.all('SELECT pair, decision FROM dupe_decisions').map((r) => [r.pair, r.decision]));
  const pairKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

  // union-find over certain matches
  const parent = new Map();
  const findRoot = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = findRoot(a), rb = findRoot(b); if (ra !== rb) parent.set(ra, rb); };
  for (const f of files) parent.set(f.id, f.id);

  const bucket = (keyFn) => {
    const m = new Map();
    for (const f of files) { const k = keyFn(f); if (k) { if (!m.has(k)) m.set(k, []); m.get(k).push(f); } }
    return m;
  };
  for (const g of bucket((f) => f.hash).values()) for (let i = 1; i < g.length; i++) union(g[0].id, g[i].id);
  for (const f of files) {
    f.sig = null;
    if (f.mesh_hash && f.tri_count > 0) { try { f.sig = JSON.parse(f.mesh_hash); } catch { /* old row */ } }
  }
  const triBuckets = [...bucket((f) => (f.sig ? f.tri_count : null)).values()].filter((g) => g.length > 1 && g.length <= 400);
  for (const g of triBuckets) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) if (sameMesh(g[i].sig, g[j].sig)) union(g[i].id, g[j].id);
  for (const [pair, d] of decisions) {
    if (d !== 'same') continue;
    const [a, b] = pair.split(':').map(Number);
    if (byId.has(a) && byId.has(b)) union(a, b);
  }

  const groupsMap = new Map();
  for (const f of files) { const r = findRoot(f.id); if (!groupsMap.has(r)) groupsMap.set(r, []); groupsMap.get(r).push(f); }

  const certain = [];
  const reps = [];
  for (const members of groupsMap.values()) {
    members.sort((a, b) => keeperScore(a) - keeperScore(b));
    const keep = members[0];
    reps.push(keep);
    if (members.length < 2) continue;
    certain.push({
      type: 'certain',
      keep: keep.id,
      reason: keeperReason(keep, members.slice(1)),
      reclaim: members.slice(1).reduce((a, m) => a + m.size, 0),
      members: members.map((m) => ({
        ...slim(m),
        match: m === keep ? 'Keep' : m.hash === keep.hash ? 'Exact copy' : m.sig && keep.sig && sameMesh(m.sig, keep.sig) ? 'Identical geometry' : 'Confirmed by you',
      })),
    });
  }
  certain.sort((a, b) => b.reclaim - a.reclaim);

  // likely pairs between group representatives
  const likely = [];
  const seen = new Set();
  const addLikely = (a, b, badge) => {
    if (a.id === b.id) return;
    const k = pairKey(a.id, b.id);
    if (seen.has(k) || decisions.has(k)) return;
    seen.add(k);
    likely.push({ type: 'likely', pair: k, badge, members: [slim(a), slim(b)] });
  };
  const meshReps = reps.filter((f) => f.sig && f.area > 0);
  const byTris = new Map();
  for (const f of meshReps) { if (!byTris.has(f.tri_count)) byTris.set(f.tri_count, []); byTris.get(f.tri_count).push(f); }
  for (const g of byTris.values()) {
    if (g.length < 2 || g.length > 200) continue;
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
      const a = g[i], b = g[j];
      const sameArea = close(a.area, b.area, 1e-4), sameVol = close(a.volume, b.volume, 1e-4);
      if (sameArea && sameVol) {
        const sameBox = close(a.bx, b.bx, 1e-4) && close(a.by, b.by, 1e-4) && close(a.bz, b.bz, 1e-4);
        addLikely(a, b, sameBox ? 'Same triangles, moved' : 'Same triangles, rotated');
      } else {
        const ca = compactness(a), cb = compactness(b);
        if (ca && cb && close(ca, cb, 1e-3)) addLikely(a, b, 'Same shape, rescaled');
      }
    }
  }
  // re-meshed: different triangle count, near-identical size and proportions
  const sorted = meshReps.filter((f) => f.volume > 1e-6 && f.tri_count >= 200).sort((a, b) => a.volume - b.volume);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && j < i + 12; j++) {
      const a = sorted[i], b = sorted[j];
      if (!close(a.volume, b.volume, 4e-3)) break;
      const ea = [a.bx, a.by, a.bz].sort((x, y) => x - y), eb = [b.bx, b.by, b.bz].sort((x, y) => x - y);
      if (a.tri_count !== b.tri_count && ea.every((v, k) => close(v, eb[k], 4e-3)) && close(a.area, b.area, 2e-2)) addLikely(a, b, 'Same shape, re-meshed');
    }
  }

  return { certain, likely: likely.slice(0, 500), archives: archiveVsUnpacked(), folders: folderDupes(files) };
}

function slim(f) {
  return { id: f.id, name: f.name, path: f.path, ext: f.ext, size: f.size, mtime: f.mtime, tri_count: f.tri_count, thumb_state: f.thumb_state, thumb_ver: f.thumb_ver };
}

function archiveVsUnpacked() {
  const out = [];
  const archivesList = db.all(`SELECT id, name, path, size FROM files WHERE kind = 'archive' AND archive_id IS NULL`);
  for (const a of archivesList) {
    const entries = db.all('SELECT name, size, crc32 FROM files WHERE archive_id = ? AND crc32 IS NOT NULL', a.id);
    if (entries.length < 1) continue;
    const dirCount = new Map();
    let matched = 0;
    for (const e of entries) {
      const hits = db.all('SELECT dir FROM files WHERE archive_id IS NULL AND size = ? AND crc32 = ? LIMIT 8', e.size, e.crc32);
      if (hits.length) matched++;
      for (const h of new Set(hits.map((x) => x.dir))) dirCount.set(h, (dirCount.get(h) || 0) + 1);
    }
    if (matched / entries.length < 0.9) continue;
    // common root of the best-matching folders
    const dirs = [...dirCount.entries()].sort((x, y) => y[1] - x[1]);
    let root = dirs[0][0];
    for (const [d] of dirs.slice(0, 20)) {
      while (root && !(d + path.sep).toLowerCase().startsWith((root + path.sep).toLowerCase())) {
        const up = path.dirname(root);
        if (up === root) { root = ''; break; }
        root = up;
      }
    }
    out.push({ type: 'archive', archive: { id: a.id, name: a.name, path: a.path, size: a.size }, folder: root || dirs[0][0], matched, total: entries.length });
  }
  return out;
}

function folderDupes(files) {
  // signature of a folder = the set of file hashes anywhere beneath it
  const sets = new Map();
  const sources = db.all('SELECT path FROM sources').map((s) => s.path.toLowerCase());
  for (const f of files) {
    let d = f.dir;
    for (let depth = 0; depth < 12; depth++) {
      if (!sets.has(d)) sets.set(d, { hashes: new Set(), bytes: 0 });
      const s = sets.get(d);
      if (!s.hashes.has(f.hash)) { s.hashes.add(f.hash); s.bytes += f.size; }
      if (sources.includes(d.toLowerCase())) break;
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  const dirs = [...sets.entries()].filter(([, s]) => s.hashes.size >= 2).map(([dir, s]) => ({ dir, ...s }));
  if (dirs.length > 4000) return [];
  const sig = (s) => [...s.hashes].sort().join(',');
  const bySig = new Map();
  for (const d of dirs) { const k = sig(d); if (!bySig.has(k)) bySig.set(k, []); bySig.get(k).push(d); }
  const out = [];
  const inside = (a, b) => (a + path.sep).toLowerCase().startsWith((b + path.sep).toLowerCase());
  const dupDirs = [];
  for (const g of bySig.values()) {
    // a parent whose only content is one child folder has the same set: keep the innermost
    const top = g.filter((d) => !g.some((o) => o !== d && inside(o.dir, d.dir)));
    if (top.length < 2) continue;
    dupDirs.push(top);
  }
  for (const top of dupDirs) {
    // skip groups whose parents are already reported as duplicates of each other
    const covered = dupDirs.some((o) => o !== top && o[0].hashes.size > top[0].hashes.size && top.every((d) => o.some((p) => inside(d.dir, p.dir))));
    if (covered) continue;
    out.push({ type: 'folder', kind: 'Whole-folder duplicate', folders: top.map((d) => ({ path: d.dir, files: d.hashes.size, bytes: d.bytes })) });
  }
  // overlap: one pack fully inside a bigger one
  const dupSigs = new Set(dupDirs.map((g) => sig(g[0])));
  const small = dirs.filter((d) => d.hashes.size >= 3 && !dupSigs.has(sig(d))).sort((a, b) => a.hashes.size - b.hashes.size).slice(0, 600);
  for (const a of small) {
    for (const b of dirs) {
      if (b.hashes.size <= a.hashes.size || inside(a.dir, b.dir) || inside(b.dir, a.dir)) continue;
      let all = true;
      for (const h of a.hashes) if (!b.hashes.has(h)) { all = false; break; }
      if (all && !out.some((o) => o.kind === 'Folder overlap' && o.folders[0].path === a.dir)) {
        out.push({ type: 'folder', kind: 'Folder overlap', folders: [{ path: a.dir, files: a.hashes.size, bytes: a.bytes }, { path: b.dir, files: b.hashes.size, bytes: b.bytes }] });
        break;
      }
    }
    if (out.length > 200) break;
  }
  return out;
}

function decide(pair, decision) {
  db.run('INSERT INTO dupe_decisions(pair, decision) VALUES(?, ?) ON CONFLICT(pair) DO UPDATE SET decision = excluded.decision', pair, decision);
}

module.exports = { find, decide };
