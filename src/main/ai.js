// Local AI: a vision model looks at each thumbnail and proposes a description
// and tags; an embedding model powers "search by what it looks like".
// Works with Ollama or any OpenAI-compatible endpoint (LM Studio, llama.cpp,
// vLLM, a Hermes model served locally, ...). Nothing leaves the endpoint you set.
const fs = require('node:fs');
const db = require('./db');
const jobs = require('./jobs');

const cfg = () => db.getSettings().ai;
const base = () => cfg().baseUrl.replace(/\/+$/, '');
const headers = () => ({ 'content-type': 'application/json', ...(cfg().apiKey ? { authorization: 'Bearer ' + cfg().apiKey } : {}) });

async function http(url, body, timeoutMs = 180000) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET', headers: headers(),
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function status() {
  const c = cfg();
  try {
    let models;
    if (c.provider === 'ollama') models = (await http(base() + '/api/tags', null, 4000)).models.map((m) => m.name);
    else models = ((await http(base().replace(/\/v1$/, '') + '/v1/models', null, 4000)).data || []).map((m) => m.id);
    return { ok: true, provider: c.provider, baseUrl: c.baseUrl, models, visionModel: c.visionModel, embedModel: c.embedModel };
  } catch (e) {
    return { ok: false, provider: c.provider, baseUrl: c.baseUrl, models: [], error: e.message, visionModel: c.visionModel, embedModel: c.embedModel };
  }
}

function mimeOf(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  return 'image/png';
}

async function chatVision(prompt, image) {
  const c = cfg();
  if (!c.visionModel) throw new Error('No vision model selected in Settings');
  if (c.provider === 'ollama') {
    const r = await http(base() + '/api/chat', {
      model: c.visionModel, stream: false, format: 'json', options: { temperature: 0.2 },
      messages: [{ role: 'user', content: prompt, images: image ? [image.toString('base64')] : undefined }],
    });
    return r.message.content;
  }
  const content = [{ type: 'text', text: prompt }];
  if (image) content.push({ type: 'image_url', image_url: { url: `data:${mimeOf(image)};base64,${image.toString('base64')}` } });
  const r = await http(base().replace(/\/v1$/, '') + '/v1/chat/completions', {
    model: c.visionModel, temperature: 0.2, messages: [{ role: 'user', content }],
  });
  return r.choices[0].message.content;
}

async function embed(text) {
  const c = cfg();
  if (!c.embedModel) return null;
  if (c.provider === 'ollama') {
    const r = await http(base() + '/api/embed', { model: c.embedModel, input: text }, 60000);
    return Float32Array.from(r.embeddings[0]);
  }
  const r = await http(base().replace(/\/v1$/, '') + '/v1/embeddings', { model: c.embedModel, input: text }, 60000);
  return Float32Array.from(r.data[0].embedding);
}

function parseJson(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model did not return JSON');
  return JSON.parse(m[0]);
}

async function tagOne(id) {
  const f = db.get('SELECT id, name, dir, ext, thumb_state FROM files WHERE id = ?', id);
  if (!f) throw new Error('No such file');
  let image = null;
  if (f.thumb_state === 1) image = await fs.promises.readFile(jobs.thumbPath(id));
  const known = db.listTags().filter((t) => t.auto !== 1).slice(0, 40).map((t) => t.name).join(', ');
  const prompt = `You are cataloguing a library of 3D-printable models.
${image ? 'The image is a preview render of the model.' : 'No preview is available; use the file name only.'}
File name: "${f.name}". Folder: "${f.dir.split(/[\\/]|::/).slice(-2).join('/')}".
Reply with JSON only: {"description": "<one plain sentence saying what the object is>", "tags": ["<3 to 7 short lowercase tags: subject, category, style, intended use>"]}
${known ? 'Reuse these existing tags when they fit: ' + known : ''}`;
  const out = parseJson(await chatVision(prompt, image));
  const description = String(out.description || '').slice(0, 400);
  const tags = (Array.isArray(out.tags) ? out.tags : []).map((t) => String(t).toLowerCase().trim()).filter((t) => t && t.length <= 30).slice(0, 8);
  let vec = null;
  try { vec = await embed(`${f.name}. ${description} Tags: ${tags.join(', ')}`); } catch { /* embeddings are optional */ }
  db.run('UPDATE files SET ai_description = ?, ai_state = 1, embedding = ? WHERE id = ?', description, vec ? Buffer.from(vec.buffer) : null, id);
  if (tags.length) db.addTags([id], tags, 2);
  jobs.notify(id);
  return { id, description, tags };
}

let run = { active: false, done: 0, total: 0, errors: 0, lastError: '', cancel: false };
async function tagMany(ids) {
  if (run.active) return run;
  if (!ids) {
    ids = db.all(`SELECT id FROM files WHERE ai_state = 0 AND kind IN ('model','cad','gcode','laser') AND thumb_state IN (1, 3) ORDER BY thumb_state, id LIMIT 5000`).map((r) => r.id);
  }
  run = { active: true, done: 0, total: ids.length, errors: 0, lastError: '', cancel: false };
  (async () => {
    for (const id of ids) {
      if (run.cancel) break;
      try { await tagOne(id); }
      catch (e) { run.errors++; run.lastError = e.message; if (run.errors >= 5 && run.done === 0) break; }
      run.done++;
      jobs.notify(-1);
    }
    run.active = false;
    jobs.notify(-1);
  })();
  return run;
}
const progress = () => run;
const cancel = () => { run.cancel = true; };

async function semanticSearch(query, limit = 40) {
  const qv = await embed(query);
  if (!qv) return null;
  const rows = db.all('SELECT id, embedding FROM files WHERE embedding IS NOT NULL');
  const norm = (v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  const qn = norm(qv);
  const scored = [];
  for (const r of rows) {
    const b = r.embedding;
    const v = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
    if (v.length !== qv.length) continue;
    let dot = 0, n = 0;
    for (let i = 0; i < v.length; i++) { dot += v[i] * qv[i]; n += v[i] * v[i]; }
    scored.push([r.id, dot / (qn * (Math.sqrt(n) || 1))]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map(([id, score]) => ({ id, score: Math.round(score * 1000) / 1000 }));
}

module.exports = { status, tagOne, tagMany, progress, cancel, semanticSearch };
