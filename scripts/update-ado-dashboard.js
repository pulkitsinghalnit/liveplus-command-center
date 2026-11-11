/**
 * Refresh the Live+ Command Center dashboard on the Live Plus WTT team.
 *
 * Shows the last 3 completed runs on QA, UAT, Stage, and Prod, and how many
 * automated test cases passed or failed on each execution module.
 *
 * Auth: SYSTEM_ACCESSTOKEN (pipeline) or ADO_PAT.
 * Inventory: config/ado-automated-test-cases.json written by generate-ci-summary.js.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { casesForPriority } = require('./test-case-rows');

const ORG = 'Stratagen';
const PROJECT = 'Live Plus';
const TEAM = process.env.DASHBOARD_TEAM || 'Live Plus WTT';
const DEFINITION_ID = 288;
const DASHBOARD_NAME = 'Live+ Command Center';
const WIDGET_NAME = 'Command Center';
const ENVS = ['qa', 'uat', 'stage', 'prod'];
const MARKDOWN_WIDGET =
  'ms.vss-dashboards-web.Microsoft.VisualStudioOnline.Dashboards.MarkdownWidget';

const TITLE_TO_PRIORITY = [
  [/pad and well/i, 1],
  [/well\s*&\s*treatment|well and treatment/i, 2],
  [/job comment/i, 3],
  [/channel input/i, 4],
  [/drilled hole/i, 5],
  [/casing/i, 6],
  [/surface line|tubing/i, 7],
  [/perforation/i, 8],
  [/directional survey/i, 9],
  [/path summary/i, 10],
  [/schematic/i, 11],
  [/heat transfer/i, 12],
  [/reservoir/i, 13],
  [/fluids and proppants|proppant/i, 14],
  [/rheolog|edit fluid/i, 16],
  [/chemical/i, 15],
  [/design treatment/i, 17],
  [/actual treatment/i, 18],
  [/treatment totals/i, 19],
  [/entry friction|friction/i, 20],
  [/plot page layout|^verify plot page/i, 21],
  [/word report|ascii/i, 22],
  [/material usage/i, 23],
  [/post job/i, 24],
  [/user-defined channel/i, 25],
  [/version control/i, 26],
  [/dashboard create/i, 27],
  [/user management/i, 28],
];

function rootDir() {
  return path.resolve(__dirname, '..');
}

function loadInventory() {
  const file =
    process.env.INVENTORY_PATH ||
    path.join(rootDir(), 'config', 'ado-automated-test-cases.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function resolveToken() {
  return String(
    process.env.SYSTEM_ACCESSTOKEN || process.env.ADO_PAT || process.env.AZURE_DEVOPS_EXT_PAT || '',
  ).trim();
}

function authHeader(token) {
  // Pipeline OAuth tokens are JWTs. A PAT is sent as basic auth.
  if (String(token).split('.').length === 3) return `Bearer ${token}`;
  return `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
}

function request(method, url, token, body, extraHeaders) {
  const payload = body ? Buffer.from(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: authHeader(token),
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
            : {}),
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : {} });
            return;
          }
          reject(new Error(`ADO HTTP ${res.statusCode} ${method} ${url}: ${text.slice(0, 400)}`));
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function api(projectPath) {
  return `https://dev.azure.com/${encodeURIComponent(ORG)}/${projectPath}`;
}

function priorityOf(title) {
  const text = String(title || '');
  for (const [re, priority] of TITLE_TO_PRIORITY) {
    if (re.test(text)) return priority;
  }
  return null;
}

function shortTest(title) {
  const text = String(title || '');
  if (/operator company/i.test(text)) return 'Operator';
  if (/abc service/i.test(text)) return 'ABC';
  if (/profile dropdown/i.test(text)) return 'Profile';
  if (/word report|ascii/i.test(text)) return 'Word report';
  if (/actual treatment/i.test(text)) return 'Actual schedule';
  if (/path summary/i.test(text)) return 'Path summary';
  if (/channel input/i.test(text)) return 'Channel inputs';
  return text.replace(/@.+$/, '').replace(/^verify\s+/i, '').slice(0, 42);
}

function istStamp(iso) {
  if (!iso) return '';
  const shifted = new Date(new Date(iso).getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = shifted.getUTCDate();
  const mon = months[shifted.getUTCMonth()];
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${dd} ${mon} ${hh}:${mm}`;
}

function bar(passed, total) {
  const width = 16;
  if (!total) return '░'.repeat(width);
  let filled = Math.max(0, Math.min(width, Math.round((width * passed) / total)));
  if (passed < total && filled === width) filled = width - 1;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildLink(id, label) {
  const href = `https://dev.azure.com/Stratagen/Live%20Plus/_build/results?buildId=${id}&view=ms.vss-test-web.build-test-results-tab`;
  return `[${label}](${href})`;
}

function caseCounts(inv) {
  const rows = inv?.priorityModuleCoverage || [];
  const counts = new Map();
  const hasCases = Array.isArray(inv?.cases) && inv.cases.length > 0;
  for (const row of rows) {
    const n = hasCases ? casesForPriority(row.priority, inv).length : Number(row.tcCount) || 0;
    counts.set(Number(row.priority), n);
  }
  const mapped = [...counts.values()].reduce((s, n) => s + n, 0);
  return { counts, mapped, inventoryTotal: Number(inv?.count) || mapped };
}

function gradeRun(run, counts) {
  const byPriority = new Map();
  for (const result of run.results) {
    const priority = priorityOf(result.name);
    if (!priority) continue;
    const bucket = byPriority.get(priority) || { priority, results: [] };
    bucket.results.push(result);
    byPriority.set(priority, bucket);
  }
  let casesPassed = 0;
  let casesFailed = 0;
  let modulesPassed = 0;
  let modulesFailed = 0;
  const rows = [];
  for (const [priority, n] of counts.counts) {
    const bucket = byPriority.get(priority);
    let status = 'not-run';
    let detail = '';
    if (bucket) {
      const failed = bucket.results.filter((r) => r.outcome !== 'Passed');
      if (failed.length) {
        status = 'failed';
        detail = failed.map((r) => shortTest(r.name)).join(', ');
        modulesFailed += 1;
        casesFailed += n;
      } else {
        status = 'passed';
        modulesPassed += 1;
        casesPassed += n;
      }
    }
    rows.push({ priority, cases: n, status, detail });
  }
  return {
    rows,
    casesPassed,
    casesFailed,
    modulesPassed,
    modulesFailed,
    modulesRan: modulesPassed + modulesFailed,
  };
}

async function loadRuns(token, keep = 3) {
  const buildsUrl =
    api(`${encodeURIComponent(PROJECT)}/_apis/build/builds`) +
    `?definitions=${DEFINITION_ID}&$top=${Math.max(40, keep * 5)}&queryOrder=queueTimeDescending&api-version=7.1`;
  const builds = (await request('GET', buildsUrl, token)).body.value || [];
  const grouped = new Map(ENVS.map((env) => [env, []]));
  for (const build of builds) {
    if (build.result === 'canceled') continue;
    if (build.status !== 'completed' && String(build.id) !== String(process.env.BUILD_BUILDID || '')) continue;
    const params = build.templateParameters || {};
    let env = String(params.testEnvironment || '').toLowerCase();
    if (!ENVS.includes(env)) continue;
    if (grouped.get(env).length >= keep) continue;
    const runUrl =
      api(`${encodeURIComponent(PROJECT)}/_apis/test/runs`) +
      `?buildUri=${encodeURIComponent(`vstfs:///Build/Build/${build.id}`)}&api-version=7.1`;
    const runs = (await request('GET', runUrl, token)).body.value || [];
    const results = [];
    for (const run of runs) {
      const resUrl =
        api(`${encodeURIComponent(PROJECT)}/_apis/test/runs/${run.id}/results`) + '?api-version=7.1';
      const page = (await request('GET', resUrl, token)).body.value || [];
      for (const item of page) {
        results.push({
          name: item.testCaseTitle || item.automatedTestName || '',
          outcome: item.outcome || '',
        });
      }
    }
    grouped.get(env).push({
      id: build.id,
      number: build.buildNumber,
      result: build.result || build.status,
      when: build.finishTime || build.queueTime,
      env,
      triggeredBy: (build.requestedFor || {}).displayName || '',
      results,
    });
  }
  return grouped;
}

function statusCell(row) {
  if (row.status === 'passed') return 'Pass';
  if (row.status === 'failed') return `Fail · ${row.detail}`;
  return '—';
}

function render(inv, grouped) {
  const counts = caseCounts(inv);
  const graded = new Map();
  for (const env of ENVS) {
    graded.set(
      env,
      (grouped.get(env) || []).map((run) => ({ run, grade: gradeRun(run, counts) })),
    );
  }
  const now = istStamp(new Date().toISOString());
  const lines = [];
  lines.push('# Live+ Command Center');
  lines.push('');
  lines.push(
    `**${counts.inventoryTotal.toLocaleString('en-US')}** automated test cases. **${counts.mapped.toLocaleString('en-US')}** are covered by the priority suite. The rest sit outside these screens.`,
  );
  lines.push('');
  lines.push(`Updated ${now} IST from [liveplus-functional-playwright-automation](https://dev.azure.com/Stratagen/Live%20Plus/_build?definitionId=${DEFINITION_ID}).`);
  lines.push('');
  lines.push('## Latest on each environment');
  lines.push('');
  lines.push('| Environment | Run | When | Modules | Cases passed | Cases failed | Pass rate |');
  lines.push('|:--|---:|:--|---:|---:|---:|:--|');
  for (const env of ENVS) {
    const latest = graded.get(env)[0];
    if (!latest) {
      lines.push(`| **${env.toUpperCase()}** | — | No run yet | — | — | — | ${bar(0, 1)} |`);
      continue;
    }
    const g = latest.grade;
    const rate = g.modulesRan ? `${g.modulesPassed}/${g.modulesRan}` : '—';
    lines.push(
      `| **${env.toUpperCase()}** | ${buildLink(latest.run.id, latest.run.number)} | ${istStamp(latest.run.when)} | ${rate} | ${g.casesPassed.toLocaleString('en-US')} | ${g.casesFailed.toLocaleString('en-US')} | \`${bar(g.casesPassed, g.casesPassed + g.casesFailed)}\` |`,
    );
  }
  lines.push('');
  lines.push('## Last 3 runs');
  lines.push('');
  for (const env of ENVS) {
    lines.push(`### ${env.toUpperCase()}`);
    lines.push('');
    const runs = graded.get(env);
    if (!runs.length) {
      lines.push('No completed run on this environment yet.');
      lines.push('');
      continue;
    }
    lines.push('| When | Run | Build result | Modules | Cases passed | Cases failed |');
    lines.push('|:--|---:|:--|---:|---:|---:|');
    for (const { run, grade } of runs) {
      const suite =
        grade.modulesRan < (counts.counts.size || 28)
          ? `${grade.modulesPassed}/${grade.modulesRan} ran`
          : `${grade.modulesPassed} pass · ${grade.modulesFailed} fail`;
      lines.push(
        `| ${istStamp(run.when)} | ${buildLink(run.id, run.number)} | ${run.result} | ${suite} | ${grade.casesPassed.toLocaleString('en-US')} | ${grade.casesFailed.toLocaleString('en-US')} |`,
      );
    }
    lines.push('');
  }

  const envWithRun = ENVS.filter((env) => graded.get(env).length);
  lines.push('## Test cases by module');
  lines.push('');
  lines.push('Each case is counted once. **Fail** is the screen whose priority test failed on that run.');
  lines.push('');
  const header = ['| Module', 'Cases', ...envWithRun.map((env) => env.toUpperCase())];
  lines.push(header.join(' | ') + ' |');
  lines.push(['|:--', '---:', ...envWithRun.map(() => ':--')].join('|') + '|');
  const coverage = inv?.priorityModuleCoverage || [];
  const latestGrade = new Map(envWithRun.map((env) => [env, graded.get(env)[0].grade]));
  for (const row of coverage) {
    const cells = [`| ${row.executionModule}`, String(counts.counts.get(Number(row.priority)) || 0)];
    for (const env of envWithRun) {
      const found = latestGrade.get(env).rows.find((r) => r.priority === Number(row.priority));
      cells.push(found ? statusCell(found) : '—');
    }
    lines.push(cells.join(' | ') + ' |');
  }
  lines.push('');
  const stage = graded.get('stage')[0];
  if (stage) {
    const failed = stage.grade.rows.filter((r) => r.status === 'failed');
    lines.push(`## Open on stage · ${stage.run.number}`);
    lines.push('');
    if (!failed.length) {
      lines.push('Every module that ran passed.');
    } else {
      for (const row of failed) {
        const name = (coverage.find((c) => Number(c.priority) === row.priority) || {}).executionModule || `P${row.priority}`;
        const noun = row.cases === 1 ? 'case' : 'cases';
        lines.push(`- **${name}** — ${row.cases.toLocaleString('en-US')} ${noun} — ${row.detail}`);
      }
    }
    lines.push('');
  }
  lines.push('A green build that executed one module is not a full-suite pass. The module column shows how much of the suite actually ran.');
  return lines.join('\n');
}

function widget(markdown) {
  return {
    name: WIDGET_NAME,
    position: { row: 1, column: 1 },
    size: { rowSpan: 8, columnSpan: 4 },
    // The Markdown widget renders `settings` as markdown. A JSON wrapper is shown as raw text.
    settings: markdown,
    settingsVersion: { major: 1, minor: 0, patch: 0 },
    contributionId: MARKDOWN_WIDGET,
  };
}

async function findDashboard(token) {
  const url =
    api(`${encodeURIComponent(PROJECT)}/${encodeURIComponent(TEAM)}/_apis/dashboard/dashboards`) +
    '?api-version=7.1-preview.3';
  const list = (await request('GET', url, token)).body;
  const rows = list.value || list.dashboardEntries || [];
  return rows.find((d) => d.name === DASHBOARD_NAME) || null;
}

async function saveDashboard(token, markdown) {
  const existing = await findDashboard(token);
  if (!existing) {
    const url =
      api(`${encodeURIComponent(PROJECT)}/${encodeURIComponent(TEAM)}/_apis/dashboard/dashboards`) +
      '?api-version=7.1-preview.3';
    const created = await request(
      'POST',
      url,
      token,
      JSON.stringify({
        name: DASHBOARD_NAME,
        description:
          'Last 3 priority-suite runs on QA, UAT, Stage, and Prod, with test-case pass and fail by module.',
        widgets: [widget(markdown)],
      }),
    );
    return created.body;
  }
  const getUrl =
    api(
      `${encodeURIComponent(PROJECT)}/${encodeURIComponent(TEAM)}/_apis/dashboard/dashboards/${existing.id}`,
    ) + '?api-version=7.1-preview.3';
  const current = await request('GET', getUrl, token);
  const dash = current.body;
  const widgets = Array.isArray(dash.widgets) ? dash.widgets.slice() : [];
  const idx = widgets.findIndex((w) => w.name === WIDGET_NAME || w.contributionId === MARKDOWN_WIDGET);
  const next = widget(markdown);
  if (idx >= 0) {
    next.id = widgets[idx].id;
    next.eTag = widgets[idx].eTag;
    widgets[idx] = { ...widgets[idx], ...next };
  } else {
    widgets.unshift(next);
  }
  const etag = dash.eTag || current.headers.etag;
  const updated = await request('PUT', getUrl, token, JSON.stringify({ ...dash, widgets }), {
    'If-Match': etag,
  });
  return updated.body;
}

async function main() {
  const token = resolveToken();
  if (!token) throw new Error('No ADO token (SYSTEM_ACCESSTOKEN / ADO_PAT)');
  const inv = loadInventory();
  if (!inv?.priorityModuleCoverage?.length) {
    throw new Error('Inventory has no priorityModuleCoverage');
  }
  const grouped = await loadRuns(token);
  const markdown = render(inv, grouped);
  const saved = await saveDashboard(token, markdown);
  const id = saved.id;
  const url = `https://dev.azure.com/Stratagen/Live%20Plus/Live%20Plus%20WTT/_dashboards/dashboard/${id}`;
  console.log(`Dashboard: ${DASHBOARD_NAME}`);
  console.log(url);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  });
}

module.exports = { render, gradeRun, caseCounts, loadRuns, ENVS, DASHBOARD_NAME };
