// Everything behind the gear icon: vendor map, sites, plants, templates, theme.

import { api, downloadFile } from './api.js';
import { alertBox, confirmDialog, el, openModal, showMessage, toast } from './ui.js';

const EDIT_ICON = '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"></path>';
const TRASH_ICON = '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>';

function matches(row, fields, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return fields.some((f) => String(row[f] ?? '').toLowerCase().includes(q));
}

function searchRow(placeholder, onInput, extra = []) {
  const input = el('input', {
    type: 'search',
    placeholder,
    autocomplete: 'off',
    onInput: () => onInput(input.value.trim()),
  });
  return { node: el('div', { class: 'field-row' }, [input, ...extra]), input };
}

function actionCell(onEdit, onDelete) {
  const mk = (title, path, cls, fn) => {
    const b = el('button', { class: `icon-btn ${cls}`, title, onClick: fn });
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
    b.style.width = '28px';
    b.style.height = '28px';
    return b;
  };
  return el('td', { style: 'text-align:right;white-space:nowrap' }, [
    mk('Edit', EDIT_ICON, '', onEdit),
    mk('Delete', TRASH_ICON, '', onDelete),
  ]);
}

function errorText(err) {
  return err && err.message ? err.message : String(err);
}

// ------------------------------------------------------------------ vendor map

async function vendorForm(existing, defaultPosition) {
  const values = existing || {
    alphabet: '',
    position: defaultPosition || 1,
    supplier_name: '',
    ms4_vendor_code: '',
    vendor_code: '',
  };

  return new Promise((resolve) => {
    let settled = false;
    const alphabet = el('input', { type: 'text', maxlength: '1', value: values.alphabet });
    const position = el('select');
    for (const p of [1, 2, 3]) {
      position.append(el('option', { value: p, text: String(p), selected: Number(values.position) === p }));
    }
    const supplier = el('input', { type: 'text', value: values.supplier_name });
    const ms4Code = el('input', { type: 'text', value: values.ms4_vendor_code });
    const vendorCode = el('input', { type: 'text', value: values.vendor_code });

    const note = alertBox('info',
      'The position is which of the 3 characters after the "-" to read. For '
      + 'Q12345-S23, position 1 reads "S" and position 2 reads "2". Entries may use '
      + 'different positions; a part number matching two of them is settled when the '
      + 'data is loaded.');

    openModal({
      title: existing ? 'Edit map entry' : 'Add map entry',
      body: [
        note,
        el('div', { class: 'form-grid' }, [
          el('label', { text: 'HP P/N vendor alphabet' }), alphabet,
          el('label', { text: 'Position (1-3)' }), position,
          el('label', { text: 'Supplier name' }), supplier,
          el('label', { text: 'MS4 vendor code' }), ms4Code,
          el('label', { text: 'Vendor code' }), vendorCode,
        ]),
      ],
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Save',
          kind: 'primary',
          onClick: (close) => {
            if (!alphabet.value.trim()) {
              showMessage('Missing value', 'HP P/N vendor alphabet is required.', 'warn');
              return;
            }
            settled = true;
            close();
            resolve({
              alphabet: alphabet.value.trim().toUpperCase(),
              position: Number(position.value),
              supplier_name: supplier.value.trim(),
              ms4_vendor_code: ms4Code.value.trim(),
              vendor_code: vendorCode.value.trim(),
            });
          },
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/**
 * Shows what an uploaded workbook would do, then lets the user merge it in or
 * replace the table outright. Shared by the vendor map, sites and plants.
 */
function importPreview({ file, preview, url, title, noun, columns }) {
  return new Promise((resolve) => {
    const s = preview.summary;
    const hasErrors = preview.errors.length > 0;

    const body = [
      hasErrors
        ? alertBox('error',
            `${preview.errors.length} row${preview.errors.length === 1 ? '' : 's'} cannot be ` +
            'imported. Fix the file and try again - nothing has been changed.')
        : alertBox('info',
            `${s.total} row${s.total === 1 ? '' : 's'} read: ${s.new} new, ` +
            `${s.updated} already there` +
            (s.file_positions && s.file_positions.length
              ? `, using position ${s.file_positions.join(' and ')}`
              : '') + '.'),
    ];

    if (s.incomplete) {
      body.push(alertBox('warn',
        `${s.incomplete} row${s.incomplete === 1 ? ' is' : 's are'} missing an MS4 vendor code ` +
        'or vendor code. Part numbers matching them will be reported as unmatched.'));
    }

    if (hasErrors) {
      body.push(el('div', { class: 'scroll-box', style: 'margin-bottom:14px' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Row' }),
            el('th', { text: columns[0].label }),
            el('th', { text: 'Problem' }),
          ])]),
          el('tbody', {}, preview.errors.map((e) => el('tr', {}, [
            el('td', { class: 'muted', text: String(e.row ?? '') }),
            el('td', { text: e.label || '-' }),
            el('td', { text: e.message }),
          ]))),
        ]),
      ]));
    }

    const showStatus = preview.rows.some((r) => 'incomplete' in r);
    if (preview.rows.length) {
      body.push(el('div', { class: 'scroll-box' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: 'Row' }),
            ...columns.map((c) => el('th', { text: c.label })),
            showStatus ? el('th', {}) : null,
          ].filter(Boolean))]),
          el('tbody', {}, preview.rows.map((r) => el('tr', {}, [
            el('td', { class: 'muted', text: String(r.row) }),
            ...columns.map((c) => el('td', {
              text: r[c.key] === '' || r[c.key] === null || r[c.key] === undefined
                ? '-'
                : String(r[c.key]),
            })),
            showStatus
              ? el('td', {}, [r.incomplete ? el('span', { class: 'tag', text: 'incomplete' }) : null])
              : null,
          ].filter(Boolean)))),
        ]),
      ]));
    }

    const canImport = !hasErrors && preview.rows.length > 0;
    let settled = false;

    const finish = (close, mode) => async () => {
      try {
        await api.upload(url, file, { mode });
        settled = true;
        close();
        resolve(mode);
      } catch (err) {
        showMessage('Import failed', errorText(err), 'error');
      }
    };

    openModal({
      title,
      width: 'wide',
      body,
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Merge',
          disabled: !canImport,
          onClick: (close) => finish(close, 'merge')(),
        },
        {
          label: s.removed
            ? `Replace all (${s.removed} ${noun}${s.removed === 1 ? '' : 's'} removed)`
            : 'Replace all',
          kind: 'primary',
          disabled: !canImport,
          onClick: (close) => finish(close, 'replace')(),
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/**
 * The "Download template" / "Import data" pair shown above each settings table.
 * Returns the nodes to drop into the toolbar.
 */
function importControls({ base, templateName, title, noun, columns, onDone }) {
  const picker = el('input', { type: 'file', class: 'hidden', accept: '.xlsx,.xlsm' });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    let preview;
    try {
      preview = await api.upload(`${base}/import`, file, { mode: 'preview' });
    } catch (err) {
      showMessage('Could not read the file', errorText(err), 'error');
      return;
    }
    const mode = await importPreview({
      file, preview, url: `${base}/import`, title, noun, columns,
    });
    if (!mode) return;
    await onDone(mode);
  });

  return [
    picker,
    el('button', {
      class: 'btn',
      text: 'Download template',
      onClick: () => downloadFile(`${base}/template`, templateName),
    }),
    el('button', { class: 'btn', text: 'Import data', onClick: () => picker.click() }),
  ];
}

export async function openVendorMap(onChanged) {
  let rows = await api.get('/api/vendor-map');
  let query = '';
  let dirty = false;

  const tbody = el('tbody');
  const table = el('table', { class: 'data' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: 'Alphabet' }),
        el('th', { text: 'Position' }),
        el('th', { text: 'Supplier name' }),
        el('th', { text: 'MS4 vendor code' }),
        el('th', { text: 'Vendor code' }),
        el('th', {}),
      ]),
    ]),
    tbody,
  ]);

  // Pre-fill new entries with the position already used most often.
  const commonPosition = () => {
    const counts = new Map();
    for (const r of rows) counts.set(r.position, (counts.get(r.position) || 0) + 1);
    let best = null;
    for (const [pos, n] of counts) if (!best || n > best[1]) best = [pos, n];
    return best ? best[0] : null;
  };

  async function reload() {
    rows = await api.get('/api/vendor-map');
    paint();
  }

  function paint() {
    const shown = rows.filter((r) =>
      matches(r, ['alphabet', 'position', 'supplier_name', 'ms4_vendor_code', 'vendor_code'], query));
    tbody.replaceChildren();
    if (!shown.length) {
      tbody.append(el('tr', {}, [
        el('td', { colspan: 6, class: 'muted', style: 'padding:18px;text-align:center',
          text: rows.length ? 'No match.' : 'No entries yet. Add one to start matching part numbers.' }),
      ]));
      return;
    }
    for (const row of shown) {
      tbody.append(el('tr', {}, [
        el('td', { text: row.alphabet }),
        el('td', { text: String(row.position) }),
        el('td', { text: row.supplier_name || '-' }),
        el('td', { text: row.ms4_vendor_code || '-' }),
        el('td', { text: row.vendor_code || '-' }),
        actionCell(
          async () => {
            const data = await vendorForm(row, row.position);
            if (!data) return;
            try {
              await api.put(`/api/vendor-map/${row.id}`, data);
              dirty = true;
              await reload();
            } catch (err) {
              showMessage('Cannot save', errorText(err), 'error');
            }
          },
          async () => {
            if (!await confirmDialog('Delete entry', `Delete the mapping for "${row.alphabet}"?`, 'Delete')) return;
            await api.del(`/api/vendor-map/${row.id}`);
            dirty = true;
            await reload();
          },
        ),
      ]));
    }
  }

  const controls = importControls({
    base: '/api/vendor-map',
    templateName: 'HPPN Vendor Map template.xlsx',
    title: 'Import vendor map',
    noun: 'entry',
    columns: [
      { key: 'alphabet', label: 'Alphabet' },
      { key: 'position', label: 'Position' },
      { key: 'supplier_name', label: 'Supplier name' },
      { key: 'ms4_vendor_code', label: 'MS4 vendor code' },
      { key: 'vendor_code', label: 'Vendor code' },
    ],
    onDone: async (mode) => {
      dirty = true;
      await reload();
      toast(mode === 'replace' ? 'Vendor map replaced.' : 'Vendor map updated.');
    },
  });

  const search = searchRow('Search the map...', (v) => { query = v; paint(); }, [
    ...controls,
    el('button', {
      class: 'btn btn-primary',
      text: 'Add entry',
      onClick: async () => {
        const data = await vendorForm(null, commonPosition());
        if (!data) return;
        try {
          await api.post('/api/vendor-map', data);
          dirty = true;
          await reload();
        } catch (err) {
          showMessage('Cannot save', errorText(err), 'error');
        }
      },
    }),
  ]);

  paint();

  openModal({
    title: 'HPPN / Vendor Map',
    width: 'wide',
    body: [search.node, el('div', { class: 'scroll-box' }, [table])],
    buttons: [{ label: 'Close', kind: 'primary' }],
    onClose: () => { if (dirty) onChanged?.(); },
  });
}

// ------------------------------------------------------------------ CCS sites

export async function openSites() {
  let rows = await api.get('/api/sites');
  let query = '';
  const tbody = el('tbody');

  async function reload() {
    rows = await api.get('/api/sites');
    paint();
  }

  function nameForm(existing) {
    return new Promise((resolve) => {
      let settled = false;
      const input = el('input', { type: 'text', value: existing ? existing.name : '' });
      openModal({
        title: existing ? 'Edit site' : 'Add site',
        width: 'narrow',
        body: [el('div', { class: 'form-grid' }, [el('label', { text: 'Site' }), input])],
        buttons: [
          { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
          {
            label: 'Save',
            kind: 'primary',
            onClick: (close) => {
              const name = input.value.trim();
              if (!name) { showMessage('Missing value', 'Site cannot be empty.', 'warn'); return; }
              settled = true;
              close();
              resolve(name);
            },
          },
        ],
        onClose: () => { if (!settled) resolve(null); },
      });
    });
  }

  function paint() {
    const shown = rows.filter((r) => matches(r, ['name'], query));
    tbody.replaceChildren();
    if (!shown.length) {
      tbody.append(el('tr', {}, [
        el('td', { colspan: 2, class: 'muted', style: 'padding:18px;text-align:center',
          text: rows.length ? 'No match.' : 'No sites yet.' }),
      ]));
      return;
    }
    for (const row of shown) {
      tbody.append(el('tr', {}, [
        el('td', { text: row.name }),
        actionCell(
          async () => {
            const name = await nameForm(row);
            if (!name) return;
            try {
              await api.put(`/api/sites/${row.id}`, { name });
              await reload();
            } catch (err) {
              showMessage('Duplicate site', errorText(err), 'error');
            }
          },
          async () => {
            if (!await confirmDialog('Delete site', `Delete site "${row.name}"?`, 'Delete')) return;
            await api.del(`/api/sites/${row.id}`);
            await reload();
          },
        ),
      ]));
    }
  }

  const controls = importControls({
    base: '/api/sites',
    templateName: 'CCS Sites template.xlsx',
    title: 'Import CCS sites',
    noun: 'site',
    columns: [{ key: 'name', label: 'Site' }],
    onDone: async (mode) => {
      await reload();
      toast(mode === 'replace' ? 'Sites replaced.' : 'Sites updated.');
    },
  });

  const search = searchRow('Search sites...', (v) => { query = v; paint(); }, [
    ...controls,
    el('button', {
      class: 'btn btn-primary',
      text: 'Add site',
      onClick: async () => {
        const name = await nameForm(null);
        if (!name) return;
        try {
          await api.post('/api/sites', { name });
          await reload();
        } catch (err) {
          showMessage('Duplicate site', errorText(err), 'error');
        }
      },
    }),
  ]);

  paint();

  openModal({
    title: 'Add CCS Sites',
    width: 'wide',
    body: [
      search.node,
      el('div', { class: 'scroll-box' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [el('th', { text: 'Site' }), el('th', {})])]),
          tbody,
        ]),
      ]),
    ],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}

// ------------------------------------------------------------------ MS4 plants

export async function openPlants() {
  let rows = await api.get('/api/plants');
  let query = '';
  const tbody = el('tbody');

  async function reload() {
    rows = await api.get('/api/plants');
    paint();
  }

  function plantForm(existing) {
    return new Promise((resolve) => {
      let settled = false;
      const plant = el('input', { type: 'text', value: existing ? existing.plant : '' });
      const org = el('input', { type: 'text', value: existing ? existing.purchase_org : '' });
      const region = el('input', { type: 'text', value: existing ? existing.region : '' });
      openModal({
        title: existing ? 'Edit plant' : 'Add plant',
        body: [
          alertBox('info', 'A plant belongs to exactly one Purchase Org, but a Purchase Org can have many plants.'),
          el('div', { class: 'form-grid' }, [
            el('label', { text: 'Plant' }), plant,
            el('label', { text: 'Purchase Org' }), org,
            el('label', { text: 'Region' }), region,
          ]),
        ],
        buttons: [
          { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
          {
            label: 'Save',
            kind: 'primary',
            onClick: (close) => {
              if (!plant.value.trim() || !org.value.trim()) {
                showMessage('Missing value', 'Plant and Purchase Org are both required.', 'warn');
                return;
              }
              settled = true;
              close();
              resolve({
                plant: plant.value.trim(),
                purchase_org: org.value.trim(),
                region: region.value.trim(),
              });
            },
          },
        ],
        onClose: () => { if (!settled) resolve(null); },
      });
    });
  }

  function paint() {
    const shown = rows.filter((r) => matches(r, ['plant', 'purchase_org', 'region'], query));
    tbody.replaceChildren();
    if (!shown.length) {
      tbody.append(el('tr', {}, [
        el('td', { colspan: 4, class: 'muted', style: 'padding:18px;text-align:center',
          text: rows.length ? 'No match.' : 'No plants yet.' }),
      ]));
      return;
    }
    for (const row of shown) {
      tbody.append(el('tr', {}, [
        el('td', { text: row.plant }),
        el('td', { text: row.purchase_org }),
        el('td', { text: row.region || '-' }),
        actionCell(
          async () => {
            const data = await plantForm(row);
            if (!data) return;
            try {
              await api.put(`/api/plants/${row.id}`, data);
              await reload();
            } catch (err) {
              showMessage('Cannot save', errorText(err), 'error');
            }
          },
          async () => {
            if (!await confirmDialog('Delete plant', `Delete plant "${row.plant}"?`, 'Delete')) return;
            await api.del(`/api/plants/${row.id}`);
            await reload();
          },
        ),
      ]));
    }
  }

  const controls = importControls({
    base: '/api/plants',
    templateName: 'MS4 Plants template.xlsx',
    title: 'Import MS4 plants',
    noun: 'plant',
    columns: [
      { key: 'plant', label: 'Plant' },
      { key: 'purchase_org', label: 'Purchase Org' },
      { key: 'region', label: 'Region' },
    ],
    onDone: async (mode) => {
      await reload();
      toast(mode === 'replace' ? 'Plants replaced.' : 'Plants updated.');
    },
  });

  const search = searchRow('Search plants, purchase orgs, regions...', (v) => { query = v; paint(); }, [
    ...controls,
    el('button', {
      class: 'btn btn-primary',
      text: 'Add Plant',
      onClick: async () => {
        const data = await plantForm(null);
        if (!data) return;
        try {
          await api.post('/api/plants', data);
          await reload();
        } catch (err) {
          showMessage('Cannot save', errorText(err), 'error');
        }
      },
    }),
  ]);

  paint();

  openModal({
    title: 'MS4 Add Plant',
    width: 'wide',
    body: [
      search.node,
      el('div', { class: 'scroll-box' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Plant' }),
              el('th', { text: 'Purchase Org' }),
              el('th', { text: 'Region' }),
              el('th', {}),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}

// ------------------------------------------------------------------ templates

export async function openTemplates(group) {
  const tbody = el('tbody');

  async function paint() {
    const rows = await api.get(`/api/templates?group=${encodeURIComponent(group)}`);
    tbody.replaceChildren();
    for (const t of rows) {
      const picker = el('input', {
        type: 'file',
        class: 'hidden',
        accept: t.extensions.join(','),
      });
      picker.addEventListener('change', async () => {
        const file = picker.files[0];
        picker.value = '';
        if (!file) return;
        try {
          await api.upload(`/api/templates/${t.key}`, file);
          toast(`${t.label} replaced.`);
          await paint();
        } catch (err) {
          showMessage('Upload failed', errorText(err), 'error');
        }
      });

      tbody.append(el('tr', {}, [
        el('td', {}, [
          el('div', { text: t.label }),
          el('div', { class: 'muted', style: 'font-size:12px', text: t.filename }),
        ]),
        el('td', { class: 'muted', text: t.is_custom ? `Replaced ${t.updated_at}` : 'Default' }),
        el('td', { style: 'text-align:right;white-space:nowrap' }, [
          picker,
          el('button', {
            class: 'btn btn-sm',
            text: 'Download',
            onClick: () => downloadFile(`/api/templates/${t.key}/download`, t.filename),
          }),
          ' ',
          el('button', {
            class: 'btn btn-sm',
            text: 'Upload',
            onClick: () => picker.click(),
          }),
          ' ',
          el('button', {
            class: 'btn btn-sm btn-ghost',
            text: 'Reset',
            disabled: !t.is_custom,
            onClick: async () => {
              if (!await confirmDialog('Reset template',
                `Replace "${t.label}" with the bundled default?`, 'Reset')) return;
              await api.post(`/api/templates/${t.key}/reset`);
              toast(`${t.label} reset to default.`);
              await paint();
            },
          }),
        ]),
      ]));
    }
  }

  await paint();

  openModal({
    title: `${group} Templates`,
    width: 'wide',
    body: [
      alertBox('info', 'These files are the layout the generated output is built on. Replace one if the company changes the required format.'),
      el('div', { class: 'scroll-box' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'Template' }),
              el('th', { text: 'Status' }),
              el('th', {}),
            ]),
          ]),
          tbody,
        ]),
      ]),
    ],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}

// ------------------------------------------------------------------ history

export async function openHistory() {
  const rows = await api.get('/api/logs?limit=200');
  const body = rows.length
    ? el('div', { class: 'scroll-box' }, [
        el('table', { class: 'data' }, [
          el('thead', {}, [
            el('tr', {}, [
              el('th', { text: 'When' }),
              el('th', { text: 'Type' }),
              el('th', { text: 'File' }),
              el('th', { class: 'num', text: 'Rows' }),
            ]),
          ]),
          el('tbody', {}, rows.map((r) => el('tr', {}, [
            el('td', { text: r.created_at.replace('T', ' ') }),
            el('td', { text: r.kind }),
            el('td', {}, [
              el('div', { text: r.filename }),
              r.detail ? el('div', { class: 'muted', style: 'font-size:12px', text: r.detail }) : null,
            ]),
            el('td', { class: 'num', text: String(r.row_count) }),
          ]))),
        ]),
      ])
    : el('p', { class: 'muted', text: 'Nothing generated yet.' });

  openModal({
    title: 'Generation history',
    width: 'wide',
    body: [body],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}
