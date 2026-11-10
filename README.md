# Printshelf

A local-first library for downloaded 3D-printing models, with an MCP server so
agents can help catalogue and import. Everything stays on this computer; source
folders are indexed in place and a scan never renames, moves or uploads a file.

## Run

    npm install
    npm start          (or double-click Printshelf.cmd)

Add the folders that hold your models with **Sources → +**, or drop a folder on
the window. `npm run samples` writes a small test library to `./samples`.

## What it does

- **Library**: thumbnails for STL, 3MF, OBJ, PLY, GLB/GLTF and FBX; slicer
  previews from 3MF, G-code and binary G-code; SVG, DXF, LightBurn and xTool
  previews; photos, PDFs and readmes kept next to their model.
- **Archives as folders**: ZIP and TAR natively, 7z and RAR through 7-Zip.
  Every model inside gets a thumbnail; opening one extracts only that entry.
- **Viewer**: orbit, pan, zoom, preset views, wireframe. Multi-part Bambu/Orca
  3MF projects load with every part in place and per-part filament colours.
- **Organise**: search, tags, collections, favourites, creator / licence /
  source URL, notes, printed status, print queue.
- **Duplicates**: same bytes → same mesh in another format → moved, rotated,
  rescaled or re-meshed → archives already unpacked → duplicate folders.
  Certain matches clean in bulk (to the Recycle Bin, one copy always stays);
  likely ones wait for you (C = same, N = different).
- **Slicer hand-off**: installed slicers are detected; drag cards into any app.
- **Local AI** (Settings → Local AI): Ollama or any OpenAI-compatible endpoint.
  A vision model describes and tags from thumbnails; an embedding model
  (e.g. `ollama pull nomic-embed-text`) enables search by meaning.

## Agents (MCP)

The app serves a loopback-only API (random port + token in `api.json` in its
data folder). `mcp/server.js` is a stdio MCP server that bridges to it and
starts the app if it is not open.

    claude mcp add printshelf -- node "<this folder>/mcp/server.js"

Claude Desktop / other clients:

    "printshelf": { "command": "node", "args": ["<this folder>/mcp/server.js"] }

Tools: library_stats, search_models, get_model, get_thumbnail, list_tags,
list_collections, list_folders, add_tags, remove_tags, set_details,
add_to_collection, remove_from_collection, print_queue_list / add / update,
import_from_url, import_file, list_pending_imports, rescan_library,
find_duplicates, ai_status, ai_tag. Agents cannot delete or move existing files.

### Importing from a URL

- A direct file link is downloaded into the import folder
  (`<import folder>/<site>/<model>/`) with its source URL recorded.
- A model page or a site that needs sign-in (MakerWorld, Printables, Patreon)
  returns `waiting_for_download`: the page title and creator are saved, and the
  next model or archive that lands in the inbox folder (your Downloads folder by
  default) within 15 minutes is moved into the library with those details. The
  agent can click Download in your signed-in browser, or call `import_file`.

## Layout

    src/main      Electron main process: database, scanner, archives, duplicates,
                  importer, AI, slicers, local API
    src/renderer  UI, 3D viewer, hidden thumbnail worker, mesh loaders
    mcp/server.js MCP bridge (stdio)

Data (database, thumbnails) lives in `%APPDATA%/Printshelf`. Set
`PRINTSHELF_DATA` to use another folder.
