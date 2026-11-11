/**
 * Build a shareable Live+ Command Center page from Azure DevOps runs.
 * Writes site/index.html. The page is static: history is embedded, so anyone
 * with the link can open it without an Azure DevOps login.
 *
 * Auth: SYSTEM_ACCESSTOKEN (pipeline) or ADO_PAT.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { loadRuns, gradeRun, caseCounts, ENVS } = require('./update-ado-dashboard');

const ORG = 'Stratagen';
const PROJECT = 'Live Plus';

function rootDir() {
  return path.resolve(__dirname, '..');
}

function resolveToken() {
  return String(
    process.env.SYSTEM_ACCESSTOKEN || process.env.ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT || '',
  ).trim();
}

function authHeader(token) {
  if (String(token).split('.').length === 3) return `Bearer ${token}`;
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

function request(method, url, token, body) {
  const payload = body ? Buffer.from(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: authHeader(token),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text ? JSON.parse(text) : {});
            return;
          }
          reject(new Error(`ADO HTTP ${res.statusCode}: ${text.slice(0, 240)}`));
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function loadInventory() {
  const file =
    process.env.INVENTORY_PATH || path.join(rootDir(), 'config', 'ado-automated-test-cases.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function inventoryCount(token) {
  const wiql =
    "select [System.Id] from WorkItems where [System.WorkItemType] = 'Test Case' " +
    "and [System.AreaPath] = 'Live Plus\\Live Plus WTT' " +
    'and [Custom.IsRegression] = True ' +
    "and not [System.Tags] contains 'API_Automation' " +
    "and not [System.Tags] contains 'API' " +
    "and not [System.Tags] contains 'visual' " +
    "and not [System.Tags] contains 'Minifrac' " +
    "and not [System.Tags] contains 'Depro' " +
    "and [Custom.AIPlaywrightAutomation] = 'Automated'";
  const url = `https://dev.azure.com/${encodeURIComponent(ORG)}/${encodeURIComponent(PROJECT)}/_apis/wit/wiql?api-version=7.1`;
  const data = await request('POST', url, token, JSON.stringify({ query: wiql }));
  return (data.workItems || []).length;
}

function buildPayload(inv, grouped, totalCases) {
  const counts = caseCounts(inv);
  const names = new Map(
    (inv?.priorityModuleCoverage || []).map((row) => [Number(row.priority), row.executionModule]),
  );
  const runs = [];
  for (const env of ENVS) {
    for (const run of grouped.get(env) || []) {
      const grade = gradeRun(run, counts);
      runs.push({
        id: run.id,
        env: run.env,
        number: run.number,
        result: run.result,
        when: run.when,
        triggeredBy: run.triggeredBy || '',
        url: `https://dev.azure.com/Stratagen/Live%20Plus/_build/results?buildId=${run.id}`,
        modulesPassed: grade.modulesPassed,
        modulesFailed: grade.modulesFailed,
        modulesRan: grade.modulesRan,
        moduleTotal: counts.counts.size,
        casesPassed: grade.casesPassed,
        casesFailed: grade.casesFailed,
        modules: grade.rows.map((row) => ({
          priority: row.priority,
          name: names.get(row.priority) || `P${row.priority}`,
          cases: row.cases,
          status: row.status,
          detail: row.detail,
        })),
      });
    }
  }
  runs.sort((a, b) => new Date(b.when) - new Date(a.when));
  return {
    generatedAt: new Date().toISOString(),
    inventory: totalCases,
    mapped: counts.mapped,
    filter: 'AI Playwright Automation = Automated, excluding Minifrac and Depro',
    pipelineUrl: 'https://dev.azure.com/Stratagen/Live%20Plus/_build?definitionId=288',
    runs,
  };
}

function page(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Live+ Command Center</title>
<style>
  :root {
    --bg: #0b1220;
    --bg-2: #111827;
    --card: #1a2332;
    --line: #243244;
    --text: #f8fafc;
    --muted: #94a3b8;
    --blue: #3b82f6;
    --blue-dim: rgba(59, 130, 246, 0.16);
    --green: #22c55e;
    --green-dim: rgba(34, 197, 94, 0.16);
    --red: #ef4444;
    --red-dim: rgba(239, 68, 68, 0.16);
    --amber: #f59e0b;
    --shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
    --sans: Inter, "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--sans); }
  body { min-height: 100vh; }
  a { color: #93c5fd; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .app { display: grid; grid-template-columns: 248px 1fr; min-height: 100vh; }
  .side {
    background: #0e1626;
    border-right: 1px solid var(--line);
    padding: 22px 16px;
    position: sticky;
    top: 0;
    height: 100vh;
  }
  .brand { display: flex; gap: 12px; align-items: center; margin-bottom: 28px; }
  .mark {
    width: 40px; height: 40px; border-radius: 12px;
    display: grid; place-items: center; font-weight: 700;
    background: linear-gradient(160deg, #3b82f6, #1d4ed8);
    box-shadow: 0 8px 20px rgba(37, 99, 235, 0.35);
  }
  .brand strong { display: block; font-size: 15px; }
  .brand span { color: var(--muted); font-size: 12px; }
  .nav a {
    display: flex; align-items: center; gap: 10px;
    color: var(--muted); padding: 10px 12px; border-radius: 12px;
    margin-bottom: 4px; font-size: 14px;
  }
  .nav a.active, .nav a:hover { background: var(--blue-dim); color: white; text-decoration: none; }
  .side-foot { position: absolute; bottom: 20px; left: 16px; right: 16px; color: var(--muted); font-size: 12px; }
  .main { padding: 28px 32px 64px; max-width: 1280px; }
  .top { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 22px; }
  h1 { margin: 0; font-size: 28px; letter-spacing: -0.03em; }
  .sub { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 18px; }
  .card {
    background: linear-gradient(180deg, rgba(255,255,255,0.03), transparent 40%), var(--card);
    border: 1px solid var(--line); border-radius: 18px; box-shadow: var(--shadow); padding: 16px 18px;
  }
  .kpi .label { color: var(--muted); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; }
  .kpi .value { font-size: 34px; font-weight: 700; letter-spacing: -0.03em; margin-top: 6px; }
  .kpi .hint { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .envs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 8px 0 22px; }
  .env { cursor: pointer; transition: transform .2s ease, border-color .2s ease; }
  .env:hover { transform: translateY(-2px); }
  .env.selected { border-color: #3b82f6; box-shadow: 0 0 0 1px #3b82f6, var(--shadow); }
  .env h2 { margin: 0 0 8px; font-size: 13px; letter-spacing: 0.08em; color: var(--muted); }
  .env .stat { font-size: 20px; font-weight: 700; }
  .bar { display: flex; gap: 4px; margin-top: 12px; height: 8px; }
  .bar i { flex: 1; border-radius: 99px; background: #243244; }
  .bar i.pass { background: var(--green); }
  .bar i.fail { background: var(--red); }
  .bar i.partial { background: var(--amber); }
  .layout { display: grid; grid-template-columns: 320px 1fr; gap: 14px; }
  .run {
    display: grid; grid-template-columns: 10px 1fr; gap: 10px;
    padding: 10px; border-radius: 12px; cursor: pointer; border: 1px solid transparent;
  }
  .run:hover, .run.selected { background: rgba(59, 130, 246, 0.08); border-color: var(--line); }
  .dot { width: 10px; height: 10px; border-radius: 99px; margin-top: 5px; background: var(--muted); }
  .dot.pass { background: var(--green); }
  .dot.fail { background: var(--red); }
  .dot.partial { background: var(--amber); }
  .run b { font-size: 13px; font-weight: 600; }
  .run small { display: block; color: var(--muted); margin-top: 2px; }
  .section-title { margin: 0 0 12px; font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
  .head-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
  .pill { border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 600; }
  .pill.pass { background: var(--green-dim); color: #86efac; }
  .pill.fail { background: var(--red-dim); color: #fca5a5; }
  .pill.partial { background: rgba(245, 158, 11, 0.16); color: #fcd34d; }
  .pill.idle { background: #243244; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; color: var(--muted); font-weight: 600; font-size: 12px; letter-spacing: 0.04em; text-transform: uppercase; padding: 8px 10px; border-bottom: 1px solid var(--line); }
  td { padding: 9px 10px; border-bottom: 1px solid rgba(36, 50, 68, 0.7); }
  tr.fail td { background: rgba(239, 68, 68, 0.06); }
  .donut-wrap { display: flex; align-items: center; gap: 16px; min-width: 280px; justify-content: flex-end; }
  .run-link { color: #94a3b8; margin-top: 8px; font-size: 13px; line-height: 1.4; max-width: 280px; }
  .donut {
    width: 84px; height: 84px; border-radius: 50%;
    display: grid; place-items: center;
    background: conic-gradient(var(--green) calc(var(--p) * 1%), #243244 0);
  }
  .donut span {
    width: 58px; height: 58px; border-radius: 50%; background: var(--card);
    display: grid; place-items: center; font-weight: 700; font-size: 14px;
  }
  .empty { color: var(--muted); padding: 12px 0; }
  @media (max-width: 980px) {
    .app { grid-template-columns: 1fr; }
    .side { position: relative; height: auto; display: flex; gap: 18px; align-items: center; }
    .nav { display: flex; gap: 6px; }
    .side-foot { display: none; }
    .kpis, .envs, .layout { grid-template-columns: 1fr; }
    .main { padding: 18px; }
  }
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><div class="mark">L+</div><div><strong>Live+ Command</strong><span>Run intelligence</span></div></div>
    <nav class="nav">
      <a class="active" href="#overview">Overview</a>
      <a href="#history">History</a>
      <a href="#modules">Modules</a>
    </nav>
    <div class="side-foot" id="generated"></div>
  </aside>
  <main class="main">
    <div class="top" id="overview">
      <div>
        <h1>Live+ Command Center</h1>
        <p class="sub" id="subtitle"></p>
      </div>
      <div id="selected-meta"></div>
    </div>
    <section class="kpis" id="kpis"></section>
    <section class="envs" id="envs"></section>
    <section class="layout">
      <article class="card" id="history">
        <h2 class="section-title">History</h2>
        <div id="history-list"></div>
      </article>
      <article class="card" id="modules">
        <div class="head-row">
          <h2 class="section-title" style="margin:0">Modules on this run</h2>
          <div id="run-pill"></div>
        </div>
        <div id="module-table"></div>
      </article>
    </section>
  </main>
</div>
<script id="lp-data" type="application/json">${json}</script>
<script>
const data = JSON.parse(document.getElementById('lp-data').textContent);
const $ = (id) => document.getElementById(id);
function when(iso) {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime());
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function resultLabel(result) {
  if (result === 'partiallySucceeded') return 'Partial';
  if (result === 'succeeded') return 'Passed';
  if (result === 'failed') return 'Failed';
  return result || '—';
}
function tone(run) {
  if (!run) return 'idle';
  if (run.modulesFailed > 0) return run.modulesRan < run.moduleTotal ? 'partial' : 'fail';
  if (run.modulesRan && run.modulesRan < run.moduleTotal) return 'partial';
  if (run.modulesRan) return 'pass';
  return 'idle';
}
function latestOf(env) {
  return data.runs.find((r) => r.env === env) || null;
}
function fullOf(env) {
  return data.runs.find((r) => r.env === env && r.modulesRan >= 20) || null;
}
function headlineOf(env) {
  return fullOf(env) || latestOf(env);
}
let selected = headlineOf('stage') || data.runs[0] || null;

function render() {
  const gen = new Date(data.generatedAt);
  $('generated').textContent = 'Updated ' + gen.toLocaleString();
  $('subtitle').textContent = data.inventory.toLocaleString() + ' automated test cases · Minifrac and Depro excluded · ' + data.mapped.toLocaleString() + ' mapped onto these screens';
  const run = selected;
  const rate = run && (run.casesPassed + run.casesFailed) ? Math.round(100 * run.casesPassed / (run.casesPassed + run.casesFailed)) : 0;
  $('kpis').innerHTML = [
    ['Automated cases', data.inventory.toLocaleString(), 'Query total'],
    ['Cases passed', run ? run.casesPassed.toLocaleString() : '—', run ? run.env.toUpperCase() + ' · this run' : ''],
    ['Cases failed', run ? run.casesFailed.toLocaleString() : '—', run ? run.modulesFailed + ' modules failed' : ''],
    ['Modules', run ? run.modulesPassed + '/' + run.modulesRan : '—', run && run.modulesRan < run.moduleTotal ? 'Suite did not finish' : 'Executed'],
  ].map(([l,v,h]) => '<article class="card kpi"><div class="label">'+l+'</div><div class="value">'+v+'</div><div class="hint">'+h+'</div></article>').join('');

  $('envs').innerHTML = ['qa','uat','stage','prod'].map((env) => {
    const latest = latestOf(env);
    const full = fullOf(env);
    const headline = headlineOf(env);
    const history = data.runs.filter((r) => r.env === env).slice(0, 8);
    const bars = history.map((r) => '<i class="'+tone(r)+'"></i>').join('') || '<i></i><i></i><i></i>';
    const label = headline ? (headline.modulesPassed + '/' + (headline.modulesRan || 0) + ' modules') : 'No run yet';
    const extra = latest && full && latest.id !== full.id ? '<div class="hint" style="color:#94a3b8;margin-top:6px">Newer short run '+latest.modulesPassed+'/'+latest.modulesRan+'</div>' : '';
    return '<article class="card env'+(run && run.env===env ? ' selected' : '')+'" data-env="'+env+'"><h2>'+env.toUpperCase()+'</h2><div class="stat">'+label+'</div>'+extra+'<div class="bar">'+bars+'</div></article>';
  }).join('');

  $('selected-meta').innerHTML = run ? '<div class="donut-wrap"><div class="donut" style="--p:'+rate+'"><span>'+rate+'%</span></div><div class="run-link"><div class="pill '+tone(run)+'">'+resultLabel(run.result)+'</div><div><a href="'+run.url+'">'+run.number+'</a><br>'+when(run.when)+'</div></div></div>' : '';

  $('history-list').innerHTML = data.runs.length ? data.runs.map((r) =>
    '<div class="run'+(run && run.id===r.id ? ' selected' : '')+'" data-id="'+r.id+'"><div class="dot '+tone(r)+'"></div><div><b>'+r.env.toUpperCase()+' · '+(r.modulesRan ? r.modulesPassed+'/'+r.modulesRan : 'No results')+' · #'+r.id+'</b><small>'+when(r.when)+' · '+r.number+'</small></div></div>'
  ).join('') : '<div class="empty">No completed runs yet.</div>';

  const mods = run ? run.modules : [];
  $('run-pill').innerHTML = run ? '<span class="pill '+tone(run)+'">'+run.env.toUpperCase()+'</span>' : '';
  $('module-table').innerHTML = mods.length ? '<table><thead><tr><th>Module</th><th>Cases</th><th>Result</th></tr></thead><tbody>'+
    mods.map((m) => '<tr class="'+m.status+'"><td>'+m.name+'</td><td>'+m.cases.toLocaleString()+'</td><td>'+(m.status==='passed'?'Pass':m.status==='failed'?'Fail · '+m.detail:'Not run')+'</td></tr>').join('')+
    '</tbody></table>' : '<div class="empty">Pick a run from history.</div>';
}
document.body.addEventListener('click', (e) => {
  const env = e.target.closest('[data-env]');
  if (env) { selected = headlineOf(env.dataset.env) || selected; render(); return; }
  const row = e.target.closest('[data-id]');
  if (row) { selected = data.runs.find((r) => String(r.id) === row.dataset.id) || selected; render(); }
});
render();
</script>
</body>
</html>
`;
}

async function main() {
  const token = resolveToken();
  if (!token) throw new Error('No ADO token (SYSTEM_ACCESSTOKEN / ADO_PAT)');
  const inv = loadInventory();
  if (!inv?.priorityModuleCoverage?.length) throw new Error('Inventory has no priority module map');
  const [grouped, totalCases] = await Promise.all([
    loadRuns(token, Number(process.env.DASHBOARD_HISTORY || 12)),
    inventoryCount(token),
  ]);
  const payload = buildPayload(inv, grouped, totalCases);
  const outDir = path.join(rootDir(), 'site');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  fs.writeFileSync(file, page(payload));
  fs.writeFileSync(path.join(outDir, 'history.json'), JSON.stringify(payload, null, 2));
  fs.copyFileSync(file, path.join(rootDir(), 'index.html'));
  fs.copyFileSync(path.join(outDir, 'history.json'), path.join(rootDir(), 'history.json'));
  console.log(`Wrote ${file}`);
  console.log(`Runs embedded: ${payload.runs.length}. Automated cases: ${payload.inventory}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { page, buildPayload };
