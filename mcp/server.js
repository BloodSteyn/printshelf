#!/usr/bin/env node
// MCP server for Printshelf (stdio). It is a thin bridge: every tool call is
// forwarded to the running app over its loopback API, so agents see exactly the
// library the app shows. If the app is not open, it is started.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const ROOT = path.join(__dirname, '..');

function dataDir() {
  if (process.env.PRINTSHELF_DATA) return path.resolve(process.env.PRINTSHELF_DATA);
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Printshelf');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Printshelf');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Printshelf');
}

function readApi() {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), 'api.json'), 'utf8')); } catch { return null; }
}

async function post(api, name, args) {
  const res = await fetch(`http://127.0.0.1:${api.port}/tool/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + api.token },
    body: JSON.stringify(args || {}), signal: AbortSignal.timeout(600000),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

let launching = null;
function launchApp() {
  if (launching) return launching;
  launching = (async () => {
    let exe;
    try { exe = require('electron'); } catch { throw new Error('Printshelf is not running and could not be started automatically. Start it with "npm start" in ' + ROOT); }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(exe, [ROOT], { detached: true, stdio: 'ignore', env }).unref();
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const api = readApi();
      if (api) { try { await post(api, 'library_stats'); return; } catch { /* not ready yet */ } }
    }
    throw new Error('Started Printshelf but it did not become ready in time.');
  })().finally(() => { launching = null; });
  return launching;
}

async function callApp(name, args) {
  let api = readApi();
  try {
    if (!api) throw Object.assign(new Error('not running'), { offline: true });
    return await post(api, name, args);
  } catch (e) {
    const offline = e.offline || /fetch failed|ECONNREFUSED|Bad token/i.test(String(e.message) + String(e.cause || ''));
    if (!offline) throw e;
    await launchApp();
    api = readApi();
    return post(api, name, args);
  }
}

const server = new McpServer({ name: 'printshelf', version: '0.1.0' }, {
  instructions: 'Printshelf is the user\'s local library of 3D-printing models. Use search_models to find things, get_thumbnail to look at a model before describing or tagging it, and add_tags / set_details / add_to_collection to catalogue. import_from_url stores a model from a link; sites that need a signed-in browser (MakerWorld, Printables downloads, Patreon) return "waiting_for_download" with the next step. These tools never delete or move the user\'s existing files.',
});

const ids = z.array(z.number().int()).min(1).describe('Model ids from search_models');

function tool(name, description, shape, opts = {}) {
  server.registerTool(name, { description, inputSchema: shape, annotations: opts.annotations }, async (args) => {
    try {
      const result = await callApp(name, args);
      if (result && result.__image) return { content: [{ type: 'image', data: result.__image, mimeType: result.mime }] };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
    }
  });
}
const RO = { annotations: { readOnlyHint: true } };

tool('library_stats', 'Counts of models, archives, tags and collections, formats in the library, the source folders, and the import and inbox folders.', {}, RO);

tool('search_models', 'Search the library. Words match the file name, folder path, tags, creator, notes and AI description (all words must match). Returns ids used by the other tools.', {
  query: z.string().optional().describe('Words to look for, e.g. "dragon articulated"'),
  semantic: z.boolean().optional().describe('Search by meaning using the local embedding model (needs AI tagging to have run); falls back to keywords'),
  tags: z.array(z.string()).optional().describe('Only models carrying all of these tags'),
  format: z.string().optional().describe('File extension such as "stl", "3mf", "step", "gcode"'),
  collection: z.string().optional().describe('Only models in this collection'),
  folder: z.string().optional().describe('Only models under this folder path (see list_folders)'),
  favorite: z.boolean().optional(),
  printed: z.boolean().optional().describe('true = already printed, false = not printed yet'),
  untagged: z.boolean().optional().describe('Only models with no hand-applied tags: useful for cataloguing passes'),
  include_companions: z.boolean().optional().describe('Also return photos, PDFs and readmes'),
  sort: z.enum(['name', 'newest', 'oldest', 'added', 'largest', 'smallest']).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Default 25'),
}, RO);

tool('get_model', 'Full details for one model: path, tags, collections, dimensions, triangle count, slicer settings stored in the file, creator, licence, source URL, notes and companion files.', { id: z.number().int() }, RO);
tool('get_thumbnail', 'Returns the preview image of a model so you can see what it is before describing or tagging it.', { id: z.number().int() }, RO);
tool('list_tags', 'All tags with usage counts and where each came from (manual, file, ai).', {}, RO);
tool('list_collections', 'All collections with their model counts.', {}, RO);
tool('list_folders', 'Browse the library tree. Without a path it lists the source folders; with a path it lists that folder\'s subfolders (archives appear as folders).', { path: z.string().optional() }, RO);

tool('add_tags', 'Add tags to one or more models. Reuse existing tags (see list_tags) where they fit.', { ids, tags: z.array(z.string().min(1).max(60)).min(1) });
tool('remove_tags', 'Remove tags from one or more models.', { ids, tags: z.array(z.string()).min(1) });
tool('set_details', 'Set catalogue details on one or more models. Only the fields you pass are changed; pass an empty string to clear a text field. This never renames or moves the file.', {
  ids,
  creator: z.string().optional(), license: z.string().optional().describe('e.g. "CC BY-NC 4.0" or "Personal use only"'),
  source_url: z.string().optional(), notes: z.string().optional(),
  description: z.string().optional().describe('One sentence saying what the object is'),
  favorite: z.boolean().optional(), printed: z.boolean().optional(),
});
tool('add_to_collection', 'Add models to a collection, creating the collection if it does not exist.', { collection: z.string().min(1), ids });
tool('remove_from_collection', 'Remove models from a collection. The models stay in the library.', { collection: z.string().min(1), ids });

tool('print_queue_list', 'The print queue with status, quantity and notes.', {}, RO);
tool('print_queue_add', 'Add models to the print queue.', { ids, qty: z.number().int().min(1).optional(), note: z.string().optional() });
tool('print_queue_update', 'Change a print queue entry (use entry_id from print_queue_list). Setting status to "done" also marks the model as printed.', {
  entry_id: z.number().int(), status: z.enum(['queued', 'printing', 'done']).optional(), qty: z.number().int().min(1).optional(), note: z.string().optional(), remove: z.boolean().optional(),
});

const importMeta = {
  name: z.string().optional().describe('Model title, used for the folder name'),
  creator: z.string().optional(), license: z.string().optional(), notes: z.string().optional(),
  tags: z.array(z.string()).optional(), collection: z.string().optional(),
};
tool('import_from_url', 'Download a model into the library from a URL and record where it came from. A direct file link (STL, 3MF, ZIP, ...) is fetched straight away. A model page or a site that needs sign-in (MakerWorld, Printables, Patreon, Thangs) returns status "waiting_for_download": the title and creator are saved, and the next model or archive that lands in the inbox folder is filed with those details. In that case download the file in the user\'s signed-in browser, or call import_file with the saved file\'s path and the pending_id.', {
  url: z.string().url(), ...importMeta,
});
tool('import_file', 'Copy a file that is already on this computer into the library (for example something just downloaded). Pass pending_id to attach the details saved by import_from_url.', {
  path: z.string().describe('Absolute path of the file'),
  pending_id: z.number().int().optional(), source_url: z.string().optional(),
  move: z.boolean().optional().describe('Move instead of copy (default copy)'),
  ...importMeta,
});
tool('list_pending_imports', 'Imports that are waiting for a browser download, and recent finished ones.', {}, RO);

tool('rescan_library', 'Rescan all source folders for new, changed and removed files.', {});
tool('find_duplicates', 'Summary of duplicate files: exact copies, identical geometry in another format, likely duplicates (moved, rotated, rescaled, re-meshed), archives already unpacked, and duplicate folders. Read-only: the user removes duplicates in the app.', {}, RO);
tool('ai_status', 'Whether the local AI provider (Ollama or an OpenAI-compatible endpoint) is reachable, which models it offers, and the progress of any tagging run.', {}, RO);
tool('ai_tag', 'Ask the app\'s local vision model to describe and tag models from their thumbnails, in the background. Without ids it processes every model not yet tagged.', { ids: z.array(z.number().int()).optional() });

server.connect(new StdioServerTransport()).catch((e) => { console.error(e); process.exit(1); });
