const fs = require('fs');
const path = 'admin-workstation.html';
let s = fs.readFileSync(path, 'utf8');

const varsOld = `    let selectedCaseId = null;\n    let paymentPollTimer = null;`;
const varsNew = `    let selectedCaseId = null;\n    let caseSearchQuery = '';\n    let paymentPollTimer = null;`;
if (!s.includes(varsOld)) throw new Error('state variables anchor not found');
s = s.replace(varsOld, varsNew);

const filteredOld = `    function filteredCases() {\n      const search = ($('case-search')?.value || '').toLowerCase().trim();\n      return casesData.filter(c => {`;
const filteredNew = `    function filteredCases() {\n      const search = String(caseSearchQuery || '').toLowerCase().trim();\n      return casesData.filter(c => {`;
if (!s.includes(filteredOld)) throw new Error('filteredCases anchor not found');
s = s.replace(filteredOld, filteredNew);

const renderDashboardOld = `      const s = stats();\n      const recent = casesData.slice(0, 8);\n\n      $('main').innerHTML =\n        '<div class="dashboard">' +`;
const renderDashboardNew = `      const s = stats();\n      const dashboardMatches = caseSearchQuery ? filteredCases() : casesData;\n      const recent = dashboardMatches.slice(0, 8);\n\n      $('main').innerHTML =\n        '<div class="panel" style="margin-bottom:14px;padding:14px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><input class="field" id="dashboard-case-search" style="flex:1;min-width:260px" placeholder="Search by client name or VRS reference..." value="' + attr(caseSearchQuery) + '" oninput="setCaseSearch(this.value, \'dashboard\')"/><button class="btn ghost" onclick="clearCaseSearch()">Clear</button></div>' + (caseSearchQuery ? '<div style="margin-top:8px;color:var(--muted);font-size:.86rem">' + recent.length + ' recent match' + (dashboardMatches.length === 1 ? '' : 'es') + ' shown · ' + dashboardMatches.length + ' total</div>' : '') + '</div>' +\n        '<div class="dashboard">' +`;
if (!s.includes(renderDashboardOld)) throw new Error('dashboard render anchor not found');
s = s.replace(renderDashboardOld, renderDashboardNew);

const workstationInputOld = `<div class="workstation"><section class="panel queue"><div class="queue-controls"><input class="field" id="case-search" placeholder="Search cases..." oninput="renderWorkstation()"/><div class="filters">`;
const workstationInputNew = `<div class="workstation"><section class="panel queue"><div class="queue-controls"><input class="field" id="case-search" placeholder="Search name, reference, employer or contact..." value="' + attr(caseSearchQuery) + '" oninput="setCaseSearch(this.value, 'workstation')"/><div class="filters">`;
if (!s.includes(workstationInputOld)) throw new Error('workstation input anchor not found');
s = s.replace(workstationInputOld, workstationInputNew);

const selectAnchor = `    function selectCase(id) { selectedCaseId = id; currentView = 'workstation'; render(); }\n`;
const searchFns = `    function setCaseSearch(value, source = 'workstation') {\n      caseSearchQuery = String(value || '');\n      if (source === 'dashboard') {\n        renderDashboard();\n        const input = $('dashboard-case-search');\n        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }\n      } else {\n        renderWorkstation();\n        const input = $('case-search');\n        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }\n      }\n    }\n\n    function clearCaseSearch() {\n      caseSearchQuery = '';\n      render();\n    }\n\n`;
if (!s.includes(selectAnchor)) throw new Error('selectCase anchor not found');
s = s.replace(selectAnchor, searchFns + selectAnchor);

fs.writeFileSync(path, s);
console.log('Persistent admin search applied');
