// File-type map shared by the scanner, importer and UI.
const KINDS = {
  model: ['stl', '3mf', 'obj', 'ply', 'glb', 'gltf', 'fbx'],
  cad: ['step', 'stp', '3dm', 'f3d', 'f3z', 'lys', 'scad', 'blend'],
  gcode: ['gcode', 'bgcode', 'gco'],
  laser: ['svg', 'dxf', 'dwg', 'xcs', 'xs', 'lbrn', 'lbrn2'],
  archive: ['zip', 'rar', '7z', 'tar', 'tgz', 'gz'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'],
  video: ['mp4', 'm4v', 'mov', 'webm'],
  doc: ['pdf', 'txt', 'md', 'markdown'],
};

const EXT_KIND = {};
for (const [kind, exts] of Object.entries(KINDS)) for (const e of exts) EXT_KIND[e] = kind;

// Formats the hidden render worker can turn into a mesh.
const MESH_EXTS = new Set(['stl', '3mf', 'obj', 'ply', 'glb', 'gltf', 'fbx']);
// Kinds that count as "a model" in the library grid.
const PRIMARY_KINDS = new Set(['model', 'cad', 'gcode', 'laser']);

function extOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'tgz';
  const i = lower.lastIndexOf('.');
  return i < 0 ? '' : lower.slice(i + 1);
}

function kindOf(name) {
  return EXT_KIND[extOf(name)] || null;
}

module.exports = { KINDS, EXT_KIND, MESH_EXTS, PRIMARY_KINDS, extOf, kindOf };
