// The CCS / MS4 generation flows: date pickers, site & plant assignment, errors.

import { api, postForFile } from './api.js';
import {
  alertBox, el, multiSelect, openModal, setBusy, showMessage, toast, todayISO,
} from './ui.js';

// ---------------------------------------------------------------- dialogs

export function askDate(title, label) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'date', value: todayISO() });
    let settled = false;
    openModal({
      title,
      width: 'narrow',
      body: [
        el('div', { class: 'form-grid' }, [el('label', { text: label }), input]),
      ],
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Continue',
          kind: 'primary',
          onClick: (close) => {
            if (!input.value) {
              showMessage('Missing date', `${label} is required.`, 'warn');
              return;
            }
            settled = true;
            close();
            resolve(input.value);
          },
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/**
 * One row per part number, each with its own multi-select, plus a bulk
 * "apply to all" control above the table.
 */
export function askAssignment({ title, what, rows, options, emptyHint }) {
  return new Promise((resolve) => {
    const parts = [...new Set(rows.map((r) => r.hppn))];
    const chosen = new Map(parts.map((p) => [p, []]));
    const controls = new Map();

    const tbody = el('tbody');
    for (const hppn of parts) {
      const ms = multiSelect({
        options,
        placeholder: `Select ${what}...`,
        onChange: (values) => chosen.set(hppn, values),
      });
      controls.set(hppn, ms);
      tbody.append(el('tr', {}, [
        el('td', { text: hppn }),
        el('td', {}, [ms.el]),
      ]));
    }

    const bulk = multiSelect({ options, placeholder: `Select ${what}...` });
    const applyAll = el('button', {
      class: 'btn',
      text: 'Apply to all',
      onClick: () => {
        const values = bulk.get();
        for (const [hppn, ms] of controls) {
          ms.set(values);
          chosen.set(hppn, [...values]);
        }
        toast(`Applied ${values.length} ${what}${values.length === 1 ? '' : 's'} to ${parts.length} part numbers.`);
      },
    });

    let settled = false;
    openModal({
      title,
      width: 'wide',
      body: [
        options.length ? null : alertBox('warn', emptyHint),
        el('div', { class: 'field-row' }, [
          el('span', { class: 'muted', text: `Set ${what} for all part numbers:` }),
          bulk.el,
          applyAll,
        ]),
        el('div', { class: 'scroll-box' }, [
          el('table', { class: 'data' }, [
            el('thead', {}, [
              el('tr', {}, [
                el('th', { text: 'HP P/N' }),
                el('th', { text: what.charAt(0).toUpperCase() + what.slice(1) }),
              ]),
            ]),
            tbody,
          ]),
        ]),
      ].filter(Boolean),
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Confirm',
          kind: 'primary',
          onClick: (close) => {
            const missing = parts.filter((p) => !(chosen.get(p) || []).length);
            if (missing.length) {
              showMessage(
                `Missing ${what}`,
                `${missing.length} part number${missing.length === 1 ? ' has' : 's have'} no ${what} selected: ` +
                missing.slice(0, 6).join(', ') + (missing.length > 6 ? '...' : ''),
                'warn',
              );
              return;
            }
            settled = true;
            close();
            resolve(Object.fromEntries(chosen));
          },
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

/**
 * A part number can match rules at more than one position once the map holds
 * several. This asks which rule wins, one part number at a time.
 * Resolves to {hppn: position} or null.
 */
export function askPositions(ambiguous) {
  return new Promise((resolve) => {
    const chosen = new Map();
    const groups = new Map();

    const describe = (c) => {
      const who = c.supplier_name || '(no supplier name)';
      const codes = c.complete
        ? `${c.ms4_vendor_code} / ${c.vendor_code}`
        : 'missing a vendor code';
      return `Position ${c.position} - "${c.alphabet}" - ${who} - ${codes}`;
    };

    const tbody = el('tbody');
    for (const item of ambiguous) {
      const name = `pos-${item.hppn.replace(/[^a-zA-Z0-9]/g, '_')}`;
      const options = [];
      for (const c of item.candidates) {
        const radio = el('input', { type: 'radio', name });
        radio.value = String(c.position);
        radio.addEventListener('change', () => {
          if (radio.checked) chosen.set(item.hppn, c.position);
        });
        options.push(el('label', {
          style: 'display:flex;align-items:center;gap:9px;padding:3px 0;cursor:pointer',
        }, [radio, el('span', { text: describe(c) })]));
      }
      groups.set(item.hppn, { options, candidates: item.candidates });
      tbody.append(el('tr', {}, [
        el('td', { style: 'vertical-align:top', text: item.hppn }),
        el('td', {}, options),
      ]));
    }

    const prefer = el('select');
    const allPositions = [...new Set(
      ambiguous.flatMap((a) => a.candidates.map((c) => c.position)),
    )].sort();
    for (const p of allPositions) {
      prefer.append(el('option', { value: p, text: `Position ${p}` }));
    }

    const applyAll = el('button', {
      class: 'btn',
      text: 'Apply to all',
      onClick: () => {
        const want = Number(prefer.value);
        let hits = 0;
        for (const [hppn, group] of groups) {
          const idx = group.candidates.findIndex((c) => c.position === want);
          if (idx < 0) continue;
          group.options[idx].querySelector('input').checked = true;
          chosen.set(hppn, want);
          hits += 1;
        }
        toast(`Position ${want} applied to ${hits} of ${groups.size} part numbers.`);
      },
    });

    let settled = false;
    openModal({
      title: 'Choose which rule applies',
      width: 'wide',
      body: [
        alertBox('warn',
          `${ambiguous.length} part number${ambiguous.length === 1 ? '' : 's'} match the vendor map ` +
          'at more than one position. Pick the rule to use for each one. ' +
          'The choice is remembered with the data.'),
        el('div', { class: 'field-row' }, [
          el('span', { class: 'muted', text: 'Prefer:' }),
          prefer,
          applyAll,
        ]),
        el('div', { class: 'scroll-box' }, [
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', { text: 'HP P/N' }),
              el('th', { text: 'Matching rules' }),
            ])]),
            tbody,
          ]),
        ]),
      ],
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(null); } },
        {
          label: 'Confirm',
          kind: 'primary',
          onClick: (close) => {
            const missing = [...groups.keys()].filter((h) => !chosen.has(h));
            if (missing.length) {
              showMessage(
                'Still undecided',
                `${missing.length} part number${missing.length === 1 ? ' has' : 's have'} no rule ` +
                `selected: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '...' : ''}`,
                'warn',
              );
              return;
            }
            settled = true;
            close();
            resolve(Object.fromEntries(chosen));
          },
        },
      ],
      onClose: () => { if (!settled) resolve(null); },
    });
  });
}

export function showUnmatched(unmatched) {
  const body = el('div', { class: 'scroll-box' }, [
    el('table', { class: 'data' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Row' }),
          el('th', { text: 'HP P/N' }),
          el('th', { text: 'Problem' }),
        ]),
      ]),
      el('tbody', {}, unmatched.map((u) => el('tr', {}, [
        el('td', { class: 'muted', text: u.row_index ?? '' }),
        el('td', { text: u.hppn }),
        el('td', { text: u.reason }),
      ]))),
    ]),
  ]);

  openModal({
    title: 'Unmatched part numbers',
    width: 'wide',
    body: [
      alertBox('error',
        `${unmatched.length} part number${unmatched.length === 1 ? '' : 's'} could not be given both ` +
        'an MS4 vendor code and a vendor code. Fix the HPPN / Vendor Map in Settings, then try again. ' +
        'Nothing has been generated.'),
      body,
    ],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}

export function showPriceProblems(problems) {
  const body = el('div', { class: 'scroll-box' }, [
    el('table', { class: 'data' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Row' }),
          el('th', { text: 'HP P/N' }),
          el('th', { text: 'Field' }),
          el('th', { text: 'Value' }),
          el('th', { text: 'Problem' }),
        ]),
      ]),
      el('tbody', {}, problems.map((p) => el('tr', {}, [
        el('td', { class: 'muted', text: p.row_index ?? '' }),
        el('td', { text: p.hppn }),
        el('td', { text: p.field }),
        el('td', { class: 'muted', text: p.value || '(blank)' }),
        el('td', { text: p.reason }),
      ]))),
    ]),
  ]);

  openModal({
    title: 'Price values need fixing',
    width: 'wide',
    body: [
      alertBox('error',
        `${problems.length} value${problems.length === 1 ? '' : 's'} are empty or not numeric. ` +
        'Correct them in the source file and upload it again. Nothing has been generated.'),
      body,
    ],
    buttons: [{ label: 'Close', kind: 'primary' }],
  });
}

// ---------------------------------------------------------------- runner

async function send(url, payload, busyLabel, onRowsChanged, retry = true) {
  setBusy(true, busyLabel);
  let result;
  try {
    result = await postForFile(url, payload);
  } catch (err) {
    setBusy(false);
    showMessage('Could not generate', err.message || String(err), 'error');
    return;
  }
  setBusy(false);
  if (!result) return;

  if (result.problem) {
    const p = result.problem;
    if (p.kind === 'ambiguous_vendors' && retry) {
      // The map grew a second rule for these parts; settle it and try again.
      const choices = await askPositions(p.ambiguous);
      if (!choices) return;
      try {
        const updated = await api.post('/api/rows/choices', { choices });
        onRowsChanged?.(updated.rows);
      } catch (err) {
        showMessage('Could not save the choice', err.message || String(err), 'error');
        return;
      }
      return send(url, payload, busyLabel, onRowsChanged, false);
    }
    if (p.kind === 'ambiguous_vendors') showMessage(
      'Still ambiguous',
      'Some part numbers still match more than one rule. Check the HPPN / Vendor Map.',
      'error',
    );
    else if (p.kind === 'unmatched_vendors') showUnmatched(p.unmatched);
    else if (p.kind === 'price_problems') showPriceProblems(p.problems);
    else showMessage('Could not generate', JSON.stringify(p), 'error');
    return;
  }
  toast(`Saved ${result.file} to your downloads.`);
}

async function siteOptions() {
  return (await api.get('/api/sites')).map((s) => s.name);
}

async function plantOptions() {
  return (await api.get('/api/plants')).map((p) => p.plant);
}

const NO_SITES = 'No CCS sites configured yet. Add them under Settings > Add CCS Sites.';
const NO_PLANTS = 'No plants configured yet. Add them under Settings > MS4 Add Plant.';

export async function runAction(action, rows, onRowsChanged) {
  const row_ids = rows.map((r) => r.id);

  if (action === 'ccs-price') {
    const date = await askDate('CCS price upload', 'Effective Date');
    if (!date) return;
    return send('/api/generate/ccs/price-upload', { row_ids, date }, 'Building CCS price upload...', onRowsChanged);
  }

  if (action === 'ccs-cnp') {
    return send('/api/generate/ccs/cnp', { row_ids }, 'Building CNP to Y...', onRowsChanged);
  }

  if (action === 'ccs-site-extend') {
    const assignments = await askAssignment({
      title: 'Assign sites (Vendor Activate)',
      what: 'site',
      rows,
      options: await siteOptions(),
      emptyHint: NO_SITES,
    });
    if (!assignments) return;
    return send('/api/generate/ccs/vendor-activate', { row_ids, assignments }, 'Building Vendor Activate...', onRowsChanged);
  }

  if (action === 'ms4-buy') {
    const date = await askDate('MS4 buy price', 'Start date');
    if (!date) return;
    const assignments = await askAssignment({
      title: 'Assign plants',
      what: 'plant',
      rows,
      options: await plantOptions(),
      emptyHint: NO_PLANTS,
    });
    if (!assignments) return;
    return send('/api/generate/ms4/buy', { row_ids, date, assignments }, 'Building MS4 buy price...', onRowsChanged);
  }

  if (action === 'ms4-sell') {
    const date = await askDate('MS4 sell price', 'Start date');
    if (!date) return;
    return send('/api/generate/ms4/sell', { row_ids, date }, 'Building MS4 sell price...', onRowsChanged);
  }

  if (action === 'ms4-esc') {
    const date = await askDate('MS4 ESC price', 'Start date');
    if (!date) return;
    return send('/api/generate/ms4/esc', { row_ids, date }, 'Building MS4 ESC price...', onRowsChanged);
  }

  if (action === 'ms4-all') {
    const date = await askDate('MS4 - generate all', 'Start date');
    if (!date) return;
    const assignments = await askAssignment({
      title: 'Assign plants',
      what: 'plant',
      rows,
      options: await plantOptions(),
      emptyHint: NO_PLANTS,
    });
    if (!assignments) return;
    return send('/api/generate/ms4/all', { row_ids, date, assignments }, 'Building all MS4 files...', onRowsChanged);
  }
}
