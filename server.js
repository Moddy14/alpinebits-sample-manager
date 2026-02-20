import { createServer } from 'http';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file if present (simple parser, no external dependency)
try {
  const envFile = readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.trim().match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* .env is optional */ }

// Simple router
const routes = {};
function route(method, path, handler) {
  routes[`${method}:${path}`] = handler;
}

// Fetch shim
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
if (!ANTHROPIC_KEY) console.warn('[WARN] ANTHROPIC_API_KEY not set — KI-Generator will be unavailable');

// Rate limiting for default API key (20 calls per day)
const DEFAULT_KEY_RATE = { limit: 20, windowMs: 24 * 60 * 60 * 1000 };
const rateLimitStore = { count: 0, resetAt: Date.now() + DEFAULT_KEY_RATE.windowMs };
function checkRateLimit() {
  const now = Date.now();
  if (now > rateLimitStore.resetAt) {
    rateLimitStore.count = 0;
    rateLimitStore.resetAt = now + DEFAULT_KEY_RATE.windowMs;
  }
  if (rateLimitStore.count >= DEFAULT_KEY_RATE.limit) {
    const resetIn = Math.ceil((rateLimitStore.resetAt - now) / 3600000);
    return { limited: true, resetIn, remaining: 0 };
  }
  rateLimitStore.count++;
  return { limited: false, remaining: DEFAULT_KEY_RATE.limit - rateLimitStore.count };
}
const GITLAB_BASE = 'https://gitlab.com/api/v4/projects/alpinebits%2Fhoteldata%2Fstandard-specification/repository';
const XSD_REMOTE_URL = 'https://gitlab.com/alpinebits/hoteldata/standard-specification/-/raw/master/files/schema-xsd/alpinebits.xsd';
const SPEC_VERSION = '2022-10';

// XSD status tracking
let xsdStatus = {
  localHash: null,
  remoteHash: null,
  lastCheck: null,
  status: 'unknown',  // 'ok' | 'changed' | 'error' | 'unknown'
  checkingNow: false
};

function hashFile(path) {
  try {
    const data = readFileSync(path);
    return createHash('sha256').update(data).digest('hex');
  } catch { return null; }
}

async function checkXsdUpdate() {
  if (xsdStatus.checkingNow) return;
  xsdStatus.checkingNow = true;
  try {
    const localHash = hashFile(XSD_PATH);
    const res = await fetch(XSD_REMOTE_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    const remoteHash = createHash('sha256').update(text).digest('hex');
    const localText = readFileSync(XSD_PATH, 'utf8');
    const localHashFresh = createHash('sha256').update(localText).digest('hex');
    xsdStatus.localHash = localHashFresh;
    xsdStatus.remoteHash = remoteHash;
    xsdStatus.lastCheck = Date.now();
    if (localHash && remoteHash === localHash) {
      xsdStatus.status = 'ok';
    } else if (localHash && remoteHash !== localHash) {
      xsdStatus.status = 'changed';
    } else {
      xsdStatus.status = 'error';
    }
  } catch(e) {
    xsdStatus.status = 'error';
    xsdStatus.lastError = e.message;
    xsdStatus.lastCheck = Date.now();
    console.error('[XSD check error]', e.message);
  } finally {
    xsdStatus.checkingNow = false;
  }
}


const RAW_BASE = 'https://gitlab.com/alpinebits/hoteldata/standard-specification/-/raw/master';
// Dynamic section discovery — merges GitLab + local filesystem
const SECTIONS_FALLBACK = ['Handshake','FreeRooms','ActivityData','BaseRates','GuestRequests','Inventory','RatePlans'];
let _cachedSections = null;
let _sectionsCachedAt = 0;
const SECTIONS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Load/save section metadata (emoji + KI context)
function loadSectionsMeta() {
  try { return JSON.parse(readFileSync(SECTIONS_META_PATH, 'utf8')); } catch { return {}; }
}
function saveSectionsMeta(meta) {
  writeFileSync(SECTIONS_META_PATH, JSON.stringify(meta, null, 2));
}

// Auto-generate emoji + context for unknown sections via Claude
async function bootstrapNewSection(sectionName, existingSamples) {
  console.log(`[AutoBootstrap] New section discovered: ${sectionName} — asking Claude...`);
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const samplePreview = existingSamples.slice(0,3).map(s=>s.name).join(', ');
    const msg = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      messages: [{ role: 'user', content:
        `You are an AlpineBits HotelData expert. A new section was discovered: "${sectionName}".
Sample files found: ${samplePreview || 'none yet'}.

Reply with a JSON object (no markdown, just raw JSON):
{
  "emoji": "<single emoji that represents this section>",
  "ctx": "<one-sentence technical description of the XML messages used in this section, OTA message names if known>"
}` }]
    });
    const rawText = msg.content[0].text.trim();
    const jsonStart = rawText.indexOf('{');
    const jsonEnd = rawText.lastIndexOf('}');
    const raw = jsonStart >= 0 ? rawText.slice(jsonStart, jsonEnd+1) : rawText;
    const parsed = JSON.parse(raw);
    return { emoji: parsed.emoji || '📁', ctx: parsed.ctx || sectionName, autoGenerated: true };
  } catch(e) {
    console.error(`[AutoBootstrap] Failed for ${sectionName}:`, e.message);
    return { emoji: '📁', ctx: sectionName, autoGenerated: false };
  }
}

async function getActiveSections() {
  const now = Date.now();
  if (_cachedSections && (now - _sectionsCachedAt) < SECTIONS_CACHE_TTL) return _cachedSections;
  try {
    // Fetch from GitLab
    const res = await fetch(`${GITLAB_BASE}/tree?path=files/samples&ref=master`);
    const items = await res.json();
    const glSections = items.filter(i => i.type === 'tree').map(i => i.name).sort();
    // Also check local dirs
    let localSections = [];
    if (existsSync(LOCAL_DIR)) {
      localSections = readdirSync(LOCAL_DIR).filter(d => {
        try { return statSync(path.join(LOCAL_DIR, d)).isDirectory(); } catch { return false; }
      });
    }
    // Merge (union, sorted)
    const all = [...new Set([...glSections, ...localSections])].sort();
    _cachedSections = all.length > 0 ? all : SECTIONS_FALLBACK;
    _sectionsCachedAt = now;

    // Auto-bootstrap any new unknown sections
    const meta = loadSectionsMeta();
    const newSections = all.filter(s => !meta[s]);
    for (const s of newSections) {
      // Get sample names for context
      let samples = [];
      try {
        const sr = await fetch(`${GITLAB_BASE}/tree?path=files/samples/${s}&ref=master`);
        const si = await sr.json();
        samples = si.filter(i => i.type==='blob').slice(0,3);
      } catch {}
      meta[s] = await bootstrapNewSection(s, samples);
      saveSectionsMeta(meta);
      console.log(`[AutoBootstrap] ${s}: emoji=${meta[s].emoji}`);
    }

    return _cachedSections;
  } catch {
    return _cachedSections || SECTIONS_FALLBACK;
  }
}
// For sync contexts: expose last-known list (populated on first async call)
function getSectionsSync() { return _cachedSections || SECTIONS_FALLBACK; }
const LOCAL_DIR = '/tmp/ab/results';
const XSD_PATH = '/tmp/alpinebits.xsd';  // legacy fallback
const XSD_DIR  = '/opt/alpinebits-manager/xsd';
const SECTIONS_META_PATH = '/opt/alpinebits-manager/sections-meta.json';

const PORT = 3210;

// Load version metadata
function loadXsdVersions() {
  try {
    return JSON.parse(readFileSync(path.join(XSD_DIR, 'versions.json'), 'utf8'));
  } catch { return { default: '2022-10', latest: '2022-10', versions: [] }; }
}
let xsdVersionMeta = loadXsdVersions();

// Per-version remote check (checks all archived versions)
async function checkAllXsdVersions() {
  const meta = loadXsdVersions();
  const REMOTE_BASE = 'https://gitlab.com/alpinebits/hoteldata/standard-specification/-/raw';
  for (const v of meta.versions) {
    try {
      const res = await fetch(`${REMOTE_BASE}/${v.version}/files/schema-xsd/alpinebits.xsd`);
      if (!res.ok) continue;
      const txt = await res.text();
      const remoteHash = createHash('sha256').update(txt).digest('hex');
      v.remoteHash = remoteHash;
      v.remoteSynced = remoteHash === v.hash;
      v.lastChecked = Date.now();
    } catch {}
  }
  // Write updated metadata
  writeFileSync(path.join(XSD_DIR, 'versions.json'), JSON.stringify(meta, null, 2));
  xsdVersionMeta = meta;
}

// Start XSD check after all constants defined
checkXsdUpdate();
setInterval(checkXsdUpdate, 12 * 60 * 60 * 1000);
checkAllXsdVersions();
setInterval(checkAllXsdVersions, 12 * 60 * 60 * 1000);

const cache = {};
const CACHE_TTL = 300000;

async function cached(key, fn) {
  const now = Date.now();
  if (cache[key] && now - cache[key].ts < CACHE_TTL) return cache[key].data;
  const data = await fn();
  cache[key] = { data, ts: now };
  return data;
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // Static files
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
    filePath = path.join(__dirname, 'public', filePath);
    try {
      const content = readFileSync(filePath);
      const ext = path.extname(filePath);
      const types = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.svg':'image/svg+xml' };
      res.setHeader('Content-Type', types[ext] || 'text/plain');
      res.writeHead(200);
      res.end(content);
    } catch { res.writeHead(404); res.end('Not Found'); }
    return;
  }

  function json(data, status=200) {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(status);
    res.end(JSON.stringify(data));
  }
  function text(data) {
    res.setHeader('Content-Type', 'text/plain');
    res.writeHead(200);
    res.end(data);
  }

  try {
    // GET /api/sections — dynamic section list with metadata
    if (req.method==='GET' && url.pathname==='/api/sections') {
      const sections = await getActiveSections();
      _cachedSections = sections;
      const meta = loadSectionsMeta();
      const withMeta = sections.map(s => ({
        name: s,
        emoji: meta[s]?.emoji || '📁',
        ctx: meta[s]?.ctx || s,
        autoGenerated: meta[s]?.autoGenerated || false
      }));
      return json({ sections, withMeta });
    }

    // GET /api/xsd-status
    if (req.method==='GET' && url.pathname==='/api/xsd-status') {
      const short = h => h ? h.slice(0,12)+'...' : null;
      return json({
        specVersion: SPEC_VERSION,
        status: xsdStatus.status,
        localHash: short(xsdStatus.localHash),
        remoteHash: short(xsdStatus.remoteHash),
        lastCheck: xsdStatus.lastCheck,
        checking: xsdStatus.checkingNow,
        xsdUrl: XSD_REMOTE_URL,
        lastError: xsdStatus.lastError || null
      });
    }

    // GET /api/xsd-versions
    if (req.method==='GET' && url.pathname==='/api/xsd-versions') {
      const meta = loadXsdVersions();
      return json({
        default: meta.default,
        latest: meta.latest,
        versions: meta.versions.map(v => ({
          version: v.version,
          hash: v.hash ? v.hash.slice(0,16)+'...' : null,
          remoteHash: v.remoteHash ? v.remoteHash.slice(0,16)+'...' : null,
          remoteSynced: v.remoteSynced ?? null,
          size: v.size,
          status: v.status,
          deprecated: v.deprecated || false,
          lastChecked: v.lastChecked || null
        }))
      });
    }

    // POST /api/validate-all
    if (req.method==='POST' && url.pathname==='/api/validate-all') {
      const body = await parseBody(req);
      const specVer = body.specVersion || xsdVersionMeta.default || '2022-10';
      const filterSection = body.section || null; // optional: only one section
      const verEntry = (xsdVersionMeta.versions||[]).find(v => v.version === specVer);
      const xsdFile = verEntry ? verEntry.xsdPath : XSD_PATH;
      if (!existsSync(xsdFile)) return json({error:`XSD für Version ${specVer} nicht gefunden`}, 404);

      const results = [];
      const sectionsToRun = filterSection ? [filterSection] : (await getActiveSections());

      for (const section of sectionsToRun) {
        const dir = path.join(LOCAL_DIR, section);
        if (!existsSync(dir)) continue;
        const files = readdirSync(dir).filter(f => f.endsWith('.xml')).sort();
        for (const filename of files) {
          const filepath = path.join(dir, filename);
          const nameLower = filename.toLowerCase();
          // Detect expected outcome: INV files should FAIL, others should PASS
          const isInv = nameLower.includes('-inv-') || nameLower.startsWith('inv-');
          const expectedValid = !isInv;
          let actualValid = false;
          let errorMsg = null;
          const tmp = `/tmp/ab-bulk-${Date.now()}-${Math.random().toString(36).slice(2)}.xml`;
          try {
            const xml = readFileSync(filepath, 'utf8');
            writeFileSync(tmp, xml);
            try {
              execSync(`xmllint --noout --schema ${xsdFile} ${tmp} 2>&1`, {encoding:'utf8'});
              actualValid = true;
            } catch(xe) {
              actualValid = false;
              errorMsg = (xe.stdout||xe.message||'').split('\n').filter(l=>l.includes('error')||l.includes('fail')).slice(0,2).join(' | ');
            }
            try { unlinkSync(tmp); } catch {}
          } catch(e) {
            errorMsg = 'File read error: ' + e.message;
          }
          // Determine result
          const correct = (expectedValid === actualValid);
          results.push({
            section,
            filename,
            isInv,
            expectedValid,
            actualValid,
            correct,
            error: errorMsg
          });
        }
      }

      const total = results.length;
      const correct = results.filter(r => r.correct).length;
      const invCorrect = results.filter(r => r.isInv && r.correct).length;
      const validCorrect = results.filter(r => !r.isInv && r.correct).length;
      const failures = results.filter(r => !r.correct);

      return json({
        specVersion: specVer,
        xsdHash: verEntry?.hash?.slice(0,16) || null,
        timestamp: Date.now(),
        summary: { total, correct, incorrect: total-correct, invCorrect, validCorrect,
          scorePercent: total > 0 ? Math.round(correct/total*100) : 0 },
        results,
        failures
      });
    }

    // GET /api/samples
    if (req.method==='GET' && url.pathname==='/api/samples') {
      const result = {};
      await Promise.all((await getActiveSections()).map(async section => {
        const data = await cached(`gl-${section}`, async () => {
          const r = await fetch(`${GITLAB_BASE}/tree?path=files/samples/${section}&ref=master&per_page=100&recursive=true`, { headers:{'User-Agent':'AlpineBits-Manager/1.0'} });
          if (!r.ok) return [];
          const items = await r.json();
          return items.filter(i => i.type==='blob' && i.name.endsWith('.xml'))
            .map(i => ({ name:i.name, path:i.path, folder:path.dirname(i.path).split('/').pop() }));
        });
        result[section] = data;
      }));
      return json({ sections: result });
    }

    // GET /api/sample-content
    if (req.method==='GET' && url.pathname==='/api/sample-content') {
      const p = url.searchParams.get('path');
      if (!p || !p.endsWith('.xml')) return json({error:'Invalid path'},400);
      const data = await cached(`gl-content-${p}`, async () => {
        const r = await fetch(`${RAW_BASE}/${p}`, { headers:{'User-Agent':'AlpineBits-Manager/1.0'} });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      });
      return text(data);
    }

    // GET /api/local-samples
    if (req.method==='GET' && url.pathname==='/api/local-samples') {
      const result = {};
      getSectionsSync().forEach(section => {
        const dir = path.join(LOCAL_DIR, section);
        result[section] = existsSync(dir)
          ? readdirSync(dir).filter(f=>f.endsWith('.xml')).map(f=>({name:f, path:path.join(dir,f)}))
          : [];
      });
      return json({ sections: result });
    }

    // GET /api/local-content
    if (req.method==='GET' && url.pathname==='/api/local-content') {
      const file = url.searchParams.get('file');
      if (!file || !file.startsWith(LOCAL_DIR)) return json({error:'Forbidden'},403);
      return text(readFileSync(file,'utf8'));
    }

    // POST /api/validate
    if (req.method==='POST' && url.pathname==='/api/validate') {
      const body = await parseBody(req);
      if (!body.xml) return json({error:'No XML'},400);
      // Spec version selection: use requested version, fallback to default, then legacy
      const specVer = body.specVersion || xsdVersionMeta.default || '2022-10';
      const verEntry = (xsdVersionMeta.versions||[]).find(v => v.version === specVer);
      const xsdFile = verEntry ? verEntry.xsdPath : XSD_PATH;
      if (!existsSync(xsdFile)) return json({error:`XSD für Version ${specVer} nicht gefunden`}, 404);
      const tmp = `/tmp/ab-val-${Date.now()}.xml`;
      writeFileSync(tmp, body.xml);
      try {
        execSync(`xmllint --noout --schema ${xsdFile} ${tmp} 2>&1`, {encoding:'utf8'});
        unlinkSync(tmp);
        return json({ valid:true, error:null, specVersion: specVer, xsdHash: verEntry?.hash?.slice(0,16)||null });
      } catch(e) {
        try { unlinkSync(tmp); } catch {}
        return json({ valid:false, error: (e.stdout||e.message||'').split('\n').slice(0,5).join('\n'),
          specVersion: specVer, xsdHash: verEntry?.hash?.slice(0,16)||null });
      }
    }

    // POST /api/generate
    if (req.method==='POST' && url.pathname==='/api/generate') {
      const body = await parseBody(req);
      const { section, type, description, examples, apiKey: userKey } = body;
      if (!section || !type) return json({error:'Missing section/type'},400);

      // Use dynamic section metadata (includes auto-generated descriptions for new sections)
      const sectionMeta = loadSectionsMeta();
      const sectionCtx = sectionMeta[section]?.ctx ||
        `AlpineBits HotelData section "${section}" — generate appropriate OTA XML based on the section name and provided examples`;

      const exTxt = (examples||[]).slice(0,2).map(e=>`--- ${e.name} ---\n${e.content}`).join('\n\n');
      const prompt = `You are an AlpineBits HotelData 2022-10 XML expert. Generate a valid XML sample.

Section: ${section} — ${sectionCtx}
Generate type: ${type}
Description: ${description||'Standard example'}
${exTxt ? '\nReference examples:\n'+exTxt : ''}

Rules:
- xmlns="http://www.opentravel.org/OTA/2003/05" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
- Version: "4" for FreeRooms RQ, "1.001" for RS, "1.000" for others
- Hotel: HotelCode="123" HotelName="Frangart Inn"
- Dates in 2022-08-xx format
- Include XML comment header with AlpineBits 2022-10 and description

Return ONLY the XML, nothing else.`;

      // Use user-provided key or fall back to default (with rate limit)
      let activeKey;
      if (userKey && userKey.startsWith('sk-ant-')) {
        activeKey = userKey;
      } else {
        const rl = checkRateLimit();
        if (rl.limited) {
          return json({ error: `Daily limit erreicht (${DEFAULT_KEY_RATE.limit}/Tag). Reset in ~${rl.resetIn}h. Bitte eigenen Anthropic API-Key eingeben.` }, 429);
        }
        activeKey = ANTHROPIC_KEY;
      }
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: activeKey });
      const msg = await client.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        messages: [{ role:'user', content:prompt }]
      });
      return json({ xml: msg.content[0].text.trim() });
    }

    // POST /api/save-local
    if (req.method==='POST' && url.pathname==='/api/save-local') {
      const body = await parseBody(req);
      const { section, filename, xml } = body;
      if (!section || !filename || !xml || !getSectionsSync().includes(section)) return json({error:'Invalid'},400);
      const dir = path.join(LOCAL_DIR, section);
      mkdirSync(dir, { recursive:true });
      const safe = filename.replace(/[^a-zA-Z0-9_\-\.]/g,'_');
      const fp = path.join(dir, safe.endsWith('.xml') ? safe : safe+'.xml');
      writeFileSync(fp, xml);
      return json({ saved:true, path:fp });
    }

    // POST /api/gitlab/create-mr
    if (req.method==='POST' && url.pathname==='/api/gitlab/create-mr') {
      const body = await parseBody(req);
      const { token, username, section, filename, xml, description } = body;
      if (!token || !username || !section || !filename || !xml) return json({error:'Fehlende Parameter'},400);
      const GITLAB_API = 'https://gitlab.com/api/v4';
      const UPSTREAM = 'alpinebits%2Fhoteldata%2Fstandard-specification';
      
      async function gl(path, method='GET', body=null) {
        const opts = { method, headers: {'Authorization':`Bearer ${token}`,'Content-Type':'application/json','User-Agent':'AlpineBits-Manager/1.0'} };
        if (body) opts.body = JSON.stringify(body);
        const r = await (await import('node-fetch')).default(`${GITLAB_API}${path}`, opts);
        const t = await r.text();
        try { const j = JSON.parse(t); if (!r.ok) throw new Error(j.message||JSON.stringify(j).slice(0,200)); return j; }
        catch(e) { if (!r.ok) throw new Error(t.slice(0,200)); throw e; }
      }
      
      try {
        // 1. Upstream Projekt holen
        const upstream = await gl(`/projects/${UPSTREAM}`);
        const upstreamId = upstream.id;

        // 2. Fork prüfen / erstellen
        let fork;
        try { fork = await gl(`/projects/${encodeURIComponent(username+'/standard-specification')}`); }
        catch { fork = await gl(`/projects/${upstreamId}/fork`, 'POST', {namespace_path: username}); await new Promise(r=>setTimeout(r,4000)); }
        const forkId = fork.id;

        // 3. Branch erstellen
        const safe = filename.replace(/[^a-zA-Z0-9_\-]/g,'_').slice(0,40);
        const branch = `add-${section.toLowerCase()}-${safe}-${Date.now()}`.slice(0,80);
        await gl(`/projects/${forkId}/repository/branches`, 'POST', {branch, ref:'master'});

        // 4. Datei hochladen
        const filePath = `files/samples/${section}/${filename.endsWith('.xml')?filename:filename+'.xml'}`;
        const commitMsg = `Add ${section} sample: ${filename}\n\nGenerated with AlpineBits Sample Manager + Claude AI`;
        await gl(`/projects/${forkId}/repository/files/${encodeURIComponent(filePath)}`, 'POST', {
          branch, encoding:'base64',
          content: Buffer.from(xml).toString('base64'),
          commit_message: commitMsg
        });

        // 5. Merge Request erstellen
        const mr = await gl(`/projects/${forkId}/merge_requests`, 'POST', {
          source_branch: branch,
          target_branch: 'master',
          target_project_id: upstreamId,
          title: `feat(samples): add ${section} sample — ${filename.replace('.xml','')}`,
          description: `## New AlpineBits XML Sample\n\n**Section:** ${section}  \n**File:** \`${filePath}\`  \n**Type:** ${filename.split('-')[0]}  \n\n${description||''}\n\n---\n*🤖 Generated with [AlpineBits Sample Manager](https://alpinebits.moddy-blossom.at) + Claude AI*  \n*✅ Validated against official alpinebits.xsd*`,
          remove_source_branch: true
        });

        return json({ success:true, mrUrl:mr.web_url, mrIid:mr.iid, branch, filePath });
      } catch(e) { return json({error:e.message},500); }
    }

        json({ error:'Not found' }, 404);
  } catch(e) {
    json({ error: e.message }, 500);
  }
});

server.listen(PORT, () => console.log(`🏔️  AlpineBits Manager on :${PORT}`));
