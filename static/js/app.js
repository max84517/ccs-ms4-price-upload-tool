// Bootstrap: data table, selection, search, upload flow, settings menu.

import { api } from './api.js';
import {
  askPositions, runAction, showCorrections, showSupplierConflicts, showUnmatched,
} from './generate.js';
import {
  askPreferredPosition, openHistory, openPlants, openSites, openTemplates,
  openVendorMap,
} from './settings.js';
import {
  alertBox, confirmDialog, el, openModal, setBusy, showMessage, toast,
} from './ui.js';

const state = {
  rows: [],
  filtered: [],
  selected: new Set(),
  query: '',
  lastIndex: null,
  theme: 'dark',
  preferredPosition: null,
};

const dom = {
  emptyState: document.getElementById('empty-state'),
  toolbar: document.getElementById('toolbar'),
  actionBars: document.getElementById('action-bars'),
  tableWrap: document.getElementById('table-wrap'),
  tbody: document.getElementById('data-body'),
  checkAll: document.getElementById('check-all'),
  search: document.getElementById('search'),
  countPill: document.getElementById('count-pill'),
  batchInfo: document.getElementById('batch-info'),
  fileInput: document.getElementById('file-input'),
  uploadLabel: document.getElementById('upload-label'),
};

// Must match app/version.py. The browser reads these files straight off disk,
// so new scripts can meet a server process that started before the change.
const EXPECTED_API_VERSION = '6';

function warnStaleServer(actual) {
  openModal({
    title: 'Restart the application',
    width: 'narrow',
    body: [
      alertBox('error',
        'The server running in the background was started before the last update, '
        + 'so saving and generating will fail.'),
      el('p', { style: 'margin:0' }, [
        'Close the ',
        el('b', { text: 'start.bat' }),
        ' window and run it again, then reload this page. Nothing is lost - all '
        + 'your data is in the database.',
      ]),
      el('p', { class: 'muted', style: 'margin:10px 0 0;font-size:12px',
        text: `Page expects API ${EXPECTED_API_VERSION}, server reports ${actual || 'an older build'}.` }),
    ],
    buttons: [{ label: 'OK', kind: 'primary' }],
  });
}

const SEARCH_FIELDS = [
  'hppn', 'supplier_name', 'ms4_vendor_code', 'vendor_code',
  'buy_price', 'sell_price', 'esc',
];

// ---------------------------------------------------------------- rendering

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  state.filtered = !q
    ? [...state.rows]
    : state.rows.filter((r) =>
        SEARCH_FIELDS.some((f) => String(r[f] ?? '').toLowerCase().includes(q)));
}

// Row nodes are kept so selection changes repaint in place instead of
// rebuilding the whole table, which matters for a few thousand rows.
let rowNodes = [];

function renderTable() {
  applyFilter();
  rowNodes = [];
  const frag = document.createDocumentFragment();

  if (!state.filtered.length) {
    frag.append(el('tr', {}, [
      el('td', {
        colspan: 9,
        class: 'muted',
        style: 'padding:26px;text-align:center',
        text: state.rows.length ? 'No rows match your search.' : 'No rows.',
      }),
    ]));
  }

  state.filtered.forEach((row, index) => {
    const checked = state.selected.has(row.id);
    const cb = el('input', { type: 'checkbox' });
    cb.checked = checked;
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      // A checkbox adds to the selection rather than replacing it.
      select(index, e.shiftKey ? 'extend' : 'toggle');
    });

    // Columns are fixed width, so anything long is clipped - the title makes
    // the full value readable on hover.
    const cell = (value, extra = {}) =>
      el('td', { text: value || '-', title: value || '', ...extra });

    const tr = el('tr', { class: checked ? 'selected' : '' }, [
      el('td', { class: 'col-check' }, [cb]),
      cell(row.hppn),
      cell(row.supplier_name),
      cell(row.ms4_vendor_code),
      cell(row.vendor_code),
      el('td', { class: 'num', text: row.buy_price || '' }),
      el('td', { class: 'num', text: row.sell_price || '' }),
      el('td', { class: 'num', text: row.esc || '' }),
      el('td', { class: 'cell-fill' }),
    ]);
    tr.addEventListener('click', (e) => {
      if (e.shiftKey) select(index, 'range');
      else select(index, e.ctrlKey || e.metaKey ? 'toggle' : 'replace');
    });
    rowNodes.push({ tr, cb, id: row.id });
    frag.append(tr);
  });

  dom.tbody.replaceChildren(frag);
  paintSelection();
}

function paintSelection() {
  for (const node of rowNodes) {
    const on = state.selected.has(node.id);
    node.cb.checked = on;
    node.tr.classList.toggle('selected', on);
  }
  paintCounts();
}

function paintCounts() {
  const total = state.rows.length;
  const shown = state.filtered.length;
  const picked = state.selected.size;
  dom.countPill.innerHTML =
    `<b>${picked}</b> selected &middot; ${shown === total ? `${total} rows` : `${shown} of ${total} rows`}`;

  const visibleIds = state.filtered.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => state.selected.has(id));
  dom.checkAll.checked = allVisibleSelected;
  dom.checkAll.indeterminate =
    !allVisibleSelected && visibleIds.some((id) => state.selected.has(id));

  dom.actionBars.classList.toggle('hidden', picked === 0);
}

/**
 * mode: 'replace' plain click, 'toggle' ctrl-click or checkbox,
 *       'range' shift-click a row (replaces), 'extend' shift-click a checkbox (adds).
 * The anchor stays where the last plain click was, the way Explorer behaves.
 */
function select(index, mode) {
  const row = state.filtered[index];
  if (!row) return;

  if ((mode === 'range' || mode === 'extend') && state.lastIndex !== null) {
    const [from, to] = state.lastIndex <= index
      ? [state.lastIndex, index]
      : [index, state.lastIndex];
    const ids = state.filtered.slice(from, to + 1).map((r) => r.id);
    if (mode === 'range') state.selected = new Set(ids);
    else ids.forEach((id) => state.selected.add(id));
  } else if (mode === 'toggle' || mode === 'extend') {
    if (state.selected.has(row.id)) state.selected.delete(row.id);
    else state.selected.add(row.id);
    state.lastIndex = index;
  } else {
    state.selected = new Set([row.id]);
    state.lastIndex = index;
  }
  paintSelection();
}

function setRows(rows, batch) {
  state.rows = rows;
  state.selected = new Set();
  state.lastIndex = null;
  const hasData = rows.length > 0;

  dom.emptyState.classList.toggle('hidden', hasData);
  dom.toolbar.classList.toggle('hidden', !hasData);
  dom.tableWrap.classList.toggle('hidden', !hasData);
  dom.uploadLabel.textContent = hasData ? 'Re-upload Excel' : 'Upload Excel';
  dom.batchInfo.textContent = batch
    ? `${batch.filename} - ${rows.length} rows - ${batch.uploaded_at.replace('T', ' ')}`
    : '';

  renderTable();
}

// ---------------------------------------------------------------- upload

function mappingDialog(parsed) {
  return new Promise((resolve) => {
    const fields = [
      ['hppn', 'HP P/N'],
      ['supplier', 'Supplier'],
      ['buy_price', 'Buy Price'],
      ['sell_price', 'Sell Price'],
      ['esc', 'ESC'],
    ];
    const selects = new Map();

    function refreshOptions() {
      const taken = new Map();
      for (const [field, sel] of selects) {
        if (sel.value !== '') taken.set(Number(sel.value), field);
      }
      for (const [field, sel] of selects) {
        const current = sel.value;
        sel.replaceChildren(el('option', { value: '', text: '-- choose a column --' }));
        parsed.headers.forEach((header, idx) => {
          const owner = taken.get(idx);
          if (owner && owner !== field) return; // a column can only be used once
          sel.append(el('option', { value: idx, text: header }));
        });
        sel.value = current;
      }
    }

    const grid = el('div', { class: 'form-grid' });
    for (const [field, label] of fields) {
      const sel = el('select', { onChange: refreshOptions });
      selects.set(field, sel);
      const detected = parsed.mapping[field];
      grid.append(el('label', {}, [
        label,
        detected === undefined ? el('span', { class: 'tag', text: ' not found', style: 'margin-left:6px' }) : '',
      ]), sel);
    }
    refreshOptions();
    for (const [field] of fields) {
      const detected = parsed.mapping[field];
      if (detected !== undefined) selects.get(field).value = String(detected);
    }
    refreshOptions();

    let settled = false;
    openModal({
      title: 'Map the columns',
      body: [
        alertBox('warn',
          `Some required columns were not found in "${parsed.filename}". Choose which column ` +
          'holds each value. Each column can only be used once.'),
        grid,
      ],
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Continue',
          kind: 'primary',
          onClick: (close) => {
            const mapping = {};
            for (const [field, label] of fields) {
              const value = selects.get(field).value;
              if (value === '') {
                showMessage('Missing column', `Choose the column that holds ${label}.`, 'warn');
                return;
              }
              mapping[field] = Number(value);
            }
            settled = true;
            close();
            resolve(mapping);
          },
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

function promptPreferredPosition(firstRun) {
  return askPreferredPosition({
    current: state.preferredPosition,
    firstRun,
    onChanged: (position, rows) => {
      state.preferredPosition = position;
      if (state.rows.length && rows) {
        state.rows = rows;
        renderTable();
      }
    },
  });
}

async function ensurePreferredPosition() {
  if (state.preferredPosition !== null) return true;
  return promptPreferredPosition(true);
}

async function handleFile(file) {
  if (!await ensurePreferredPosition()) return;
  setBusy(true, 'Reading the workbook...');
  let parsed;
  try {
    parsed = await api.upload('/api/upload', file);
  } catch (err) {
    setBusy(false);
    showMessage('Could not read the file', err.message || String(err), 'error');
    return;
  }
  setBusy(false);

  let mapping = parsed.mapping;
  if (parsed.missing.length) {
    const picked = await mappingDialog(parsed);
    if (!picked) return;
    mapping = picked;
  }

  // Part numbers that match the map at two positions have to be settled
  // before anything is stored, so this loops until the backend is happy.
  let choices = {};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    setBusy(true, 'Matching vendors...');
    let result;
    try {
      result = await api.post('/api/upload/confirm', { token: parsed.token, mapping, choices });
    } catch (err) {
      setBusy(false);
      showMessage('Could not load the data', err.message || String(err), 'error');
      return;
    }
    setBusy(false);

    if (result.ok) {
      setRows(result.rows, result.batch);
      toast(`Loaded ${result.rows.length} rows from ${result.batch.filename}.`);
      showCorrections(result.corrections || []);
      return;
    }
    if (result.kind === 'ambiguous_vendors') {
      const picked = await askPositions(result.ambiguous);
      if (!picked) return;
      choices = { ...choices, ...picked };
      continue;
    }
    if (result.kind === 'no_preferred_position') {
      if (!await promptPreferredPosition(true)) return;
      continue;
    }
    if (result.kind === 'supplier_conflicts') {
      showSupplierConflicts(result.corrections);
      return;
    }
    showUnmatched(result.unmatched);
    return;
  }
  showMessage(
    'Could not load the data',
    'Some part numbers still match more than one rule. Check the HPPN / Vendor Map.',
    'error',
  );
}

// ---------------------------------------------------------------- settings menu

function closeMenu() {
  document.querySelector('.menu')?.remove();
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.menu') && !e.target.closest('#btn-settings')) closeMenu();
});

function themeSwitch() {
  const sw = el('span', { class: `switch ${state.theme === 'dark' ? 'on' : ''}` }, [el('i')]);
  return sw;
}

async function setTheme(theme, persist = true) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try { await api.put('/api/settings/theme', { theme }); } catch { /* non fatal */ }
  }
}

function openSettingsMenu(anchor) {
  if (document.querySelector('.menu')) { closeMenu(); return; }

  const item = (label, onClick, trailing = null) =>
    el('button', { onClick: () => { closeMenu(); onClick(); } }, [
      el('span', { text: label }),
      trailing,
    ]);

  const sw = themeSwitch();
  const themeItem = el('button', {
    onClick: async (e) => {
      e.stopPropagation();
      await setTheme(state.theme === 'dark' ? 'light' : 'dark');
      sw.classList.toggle('on', state.theme === 'dark');
    },
  }, [el('span', { text: 'Dark mode' }), sw]);

  const menu = el('div', { class: 'menu' }, [
    item('HPPN / Vendor Map', () => openVendorMap(refreshRows)),
    el('div', { class: 'menu-sep' }),
    item('CCS Templates', () => openTemplates('CCS')),
    item('Add CCS Sites', () => openSites()),
    el('div', { class: 'menu-sep' }),
    item('MS4 Templates', () => openTemplates('MS4')),
    item('MS4 Add Plant', () => openPlants()),
    el('div', { class: 'menu-sep' }),
    item('Generation history', () => openHistory()),
    themeItem,
  ]);

  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${Math.min(r.left, window.innerWidth - menu.offsetWidth - 12)}px`;
}

async function refreshRows() {
  try {
    const data = await api.get('/api/state');
    const keep = new Set(state.selected);
    setRows(data.rows, data.batch);
    state.selected = new Set([...keep].filter((id) => data.rows.some((r) => r.id === id)));
    paintSelection();
  } catch (err) {
    showMessage('Could not refresh', err.message || String(err), 'error');
  }
}

// ---------------------------------------------------------------- wiring

dom.search.addEventListener('input', () => {
  state.query = dom.search.value;
  state.lastIndex = null;
  renderTable();
});

dom.checkAll.addEventListener('change', () => {
  const ids = state.filtered.map((r) => r.id);
  if (dom.checkAll.checked) ids.forEach((id) => state.selected.add(id));
  else ids.forEach((id) => state.selected.delete(id));
  state.lastIndex = null;
  paintSelection();
});

document.getElementById('btn-clear-selection').addEventListener('click', () => {
  state.selected = new Set();
  state.lastIndex = null;
  paintSelection();
});

for (const id of ['btn-upload', 'btn-upload-empty']) {
  document.getElementById(id).addEventListener('click', () => dom.fileInput.click());
}

dom.fileInput.addEventListener('change', async () => {
  const file = dom.fileInput.files[0];
  dom.fileInput.value = '';
  if (file) await handleFile(file);
});

document.getElementById('btn-settings').addEventListener('click', (e) => {
  e.stopPropagation();
  openSettingsMenu(e.currentTarget);
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  if (!await confirmDialog('Log out', 'This closes the application. Continue?', 'Log out')) return;
  try { await api.post('/api/shutdown'); } catch { /* the server is going away */ }
  document.body.innerHTML =
    '<div style="display:flex;height:100vh;align-items:center;justify-content:center;' +
    'flex-direction:column;gap:10px;color:var(--text-dim)">' +
    '<h2 style="color:var(--text);margin:0">Application closed</h2>' +
    '<p>You can close this browser tab.</p></div>';
});

document.getElementById('action-bars').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const rows = state.rows.filter((r) => state.selected.has(r.id));
  if (!rows.length) {
    showMessage('Nothing selected', 'Select at least one row first.', 'warn');
    return;
  }
  runAction(btn.dataset.action, rows, (fresh) => {
    // The map choice made mid-flow changes the vendor columns on screen.
    state.rows = fresh;
    renderTable();
  });
});

// ---------------------------------------------------------------- start

(async function start() {
  try {
    const data = await api.get('/api/state');
    await setTheme(data.theme || 'dark', false);
    state.preferredPosition = data.preferred_position ?? null;
    setRows(data.rows, data.batch);

    if (data.api_version !== EXPECTED_API_VERSION) {
      warnStaleServer(data.api_version);
      return;
    }
    if (state.preferredPosition === null) await promptPreferredPosition(true);
  } catch (err) {
    showMessage('Could not start', err.message || String(err), 'error');
  }
})();
