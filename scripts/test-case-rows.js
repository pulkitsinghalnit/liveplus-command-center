/**
 * Assign ADO test cases to one execution module and render them as the
 * Extensions / email detail. A case is listed once. Shared ADO modules
 * (wellbore, material, treatment schedule, plot) are split by title so the
 * same case is not shown as both passed and failed.
 */

const PRIORITY_HINTS = {
  5: ['drilled hole'],
  6: ['casing'],
  7: ['surface line', 'tubing'],
  8: ['perforation', 'perf interval', 'perforat'],
  9: ['directional survey'],
  10: ['path summary', 'frac string'],
  11: ['schematic'],
  14: ['proppant', 'add material'],
  15: ['chemical', 'additive'],
  16: ['rheolog', 'edit fluid'],
  17: ['design treatment', 'design schedule'],
  18: ['actual treatment', 'actual schedule'],
  19: ['treatment total'],
  22: ['word report', 'ascii'],
};

function coverageRows(inv) {
  return inv?.priorityModuleCoverage || inv?.inventory?.priorityModuleCoverage || [];
}

function allCases(inv) {
  const raw = inv?.cases || inv?.inventory?.cases || [];
  return Array.isArray(raw) ? raw : [];
}

function inventoryHasCases(inv) {
  return allCases(inv).length > 0;
}

function hintScore(title, priority) {
  const text = String(title || '').toLowerCase();
  let best = 0;
  for (const hint of PRIORITY_HINTS[Number(priority)] || []) {
    if (text.includes(hint) && hint.length > best) best = hint.length;
  }
  return best;
}

/** Cases whose ADO module matches this priority. Each case belongs to one priority. */
function casesForPriority(priority, inv) {
  const rows = coverageRows(inv);
  const row = rows.find((r) => Number(r.priority) === Number(priority));
  if (!row) return [];
  const pool = allCases(inv).filter((c) => c.module === row.adoModule);
  const siblings = rows
    .filter((r) => r.adoModule === row.adoModule)
    .slice()
    .sort((a, b) => Number(a.priority) - Number(b.priority));
  if (siblings.length <= 1) {
    return pool.slice().sort((a, b) => Number(a.id) - Number(b.id));
  }
  const owned = pool.filter((c) => {
    let bestPriority = null;
    let bestScore = 0;
    for (const sib of siblings) {
      const score = hintScore(c.title, sib.priority);
      if (score > bestScore) {
        bestScore = score;
        bestPriority = Number(sib.priority);
      }
    }
    if (bestPriority == null) return Number(siblings[0].priority) === Number(priority);
    return bestPriority === Number(priority);
  });
  return owned.sort((a, b) => Number(a.id) - Number(b.id));
}

function listedCount(priority, inv) {
  if (!inventoryHasCases(inv)) return null;
  return casesForPriority(priority, inv).length;
}

function testCaseSummary(test, inv) {
  if (!inventoryHasCases(inv)) return '';
  const n = casesForPriority(
    Number(String(test.project || '').match(/P(\d+)/i)?.[1] || 0),
    inv,
  ).length;
  if (!n) return '0 mapped';
  if (test.status === 'passed') return `${n}/${n} passed`;
  if (test.status === 'failed' || test.status === 'timedOut') return `0/${n} passed`;
  return `${n} ${test.status}`;
}

function testCaseCell(test, inv) {
  if (!inventoryHasCases(inv)) return '—';
  const n = casesForPriority(
    Number(String(test.project || '').match(/P(\d+)/i)?.[1] || 0),
    inv,
  ).length;
  if (test.status === 'passed') return `${n}/${n}`;
  if (test.status === 'failed' || test.status === 'timedOut') return `0/${n}`;
  return String(n);
}

module.exports = {
  PRIORITY_HINTS,
  coverageRows,
  allCases,
  inventoryHasCases,
  casesForPriority,
  listedCount,
  testCaseSummary,
  testCaseCell,
};
