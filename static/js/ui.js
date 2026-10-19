// Small DOM / overlay primitives shared by every screen.

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') {
      Object.assign(node.dataset, value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(path, size = 16) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.innerHTML = path;
  return svg;
}

const ICONS = {
  warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
  info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
  close: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
  caret: '<polyline points="6 9 12 15 18 9"></polyline>',
};

export function alertBox(kind, message) {
  return el('div', { class: `alert alert-${kind}` }, [
    icon(kind === 'error' || kind === 'warn' ? ICONS.warning : ICONS.info),
    el('div', {}, message),
  ]);
}

// ---------------------------------------------------------------- modals

const modalStack = [];

export function openModal({ title, body, buttons = [], width = '', onClose = null }) {
  const content = el('div', { class: 'modal-body' }, body);
  const foot = el('div', { class: 'modal-foot' });
  const modal = el('div', { class: `modal ${width}` });
  const overlay = el('div', { class: 'overlay' }, modal);

  const close = (result) => {
    const idx = modalStack.indexOf(entry);
    if (idx >= 0) modalStack.splice(idx, 1);
    overlay.remove();
    if (onClose) onClose(result);
  };
  const entry = { overlay, close };

  const head = el('div', { class: 'modal-head' }, [
    el('h3', { text: title }),
    el('button', { class: 'icon-btn', title: 'Close', onClick: () => close(null) }, [
      icon(ICONS.close, 16),
    ]),
  ]);

  for (const b of buttons) {
    if (b.spacer) {
      foot.append(el('div', { class: 'left' }, b.node || ''));
      continue;
    }
    const btn = el('button', {
      class: `btn ${b.kind ? 'btn-' + b.kind : ''}`,
      text: b.label,
      onClick: () => b.onClick ? b.onClick(close, btn) : close(null),
    });
    if (b.disabled) btn.disabled = true;
    if (b.ref) b.ref(btn);
    foot.append(btn);
  }

  modal.append(head, content);
  if (buttons.length) modal.append(foot);

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close(null);
  });

  document.body.append(overlay);
  modalStack.push(entry);
  const focusable = modal.querySelector('input, select, button.btn-primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { overlay, modal, body: content, close };
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalStack.length) {
    modalStack[modalStack.length - 1].close(null);
  }
});

export function showMessage(title, message, kind = 'info') {
  return openModal({
    title,
    width: 'narrow',
    body: [alertBox(kind, message)],
    buttons: [{ label: 'OK', kind: 'primary' }],
  });
}

export function confirmDialog(title, message, confirmLabel = 'Confirm') {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      width: 'narrow',
      body: [el('p', { text: message, style: 'margin:0' })],
      buttons: [
        { label: 'Cancel', onClick: (close) => { settled = true; close(); resolve(false); } },
        {
          label: confirmLabel,
          kind: 'danger',
          onClick: (close) => { settled = true; close(); resolve(true); },
        },
      ],
      onClose: () => { if (!settled) resolve(false); },
    });
  });
}

// ---------------------------------------------------------------- toasts

export function toast(message, kind = 'ok', timeout = 4200) {
  const host = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}` }, [el('div', {}, message)]);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

// ---------------------------------------------------------------- busy

let busyNode = null;

export function setBusy(on, label = 'Working...') {
  if (on) {
    if (busyNode) return;
    busyNode = el('div', { class: 'blocking' }, [el('div', { class: 'spinner' }), label]);
    document.body.append(busyNode);
  } else if (busyNode) {
    busyNode.remove();
    busyNode = null;
  }
}

// ---------------------------------------------------------------- multiselect

let openPanel = null;

function closeOpenPanel() {
  if (openPanel) {
    openPanel.remove();
    openPanel = null;
  }
}

document.addEventListener('mousedown', (e) => {
  if (openPanel && !openPanel.contains(e.target) && !e.target.closest('.ms-toggle')) {
    closeOpenPanel();
  }
});
window.addEventListener('resize', closeOpenPanel);

/**
 * A dropdown that lets the user tick several options, with its own search box.
 * The panel is attached to <body> so it is never clipped by a scrolling table.
 */
export function multiSelect({ options, selected = [], placeholder = 'Select...', onChange }) {
  let chosen = new Set(selected);
  const text = el('span', { class: 'ms-text' });
  const toggle = el('button', { class: 'ms-toggle', type: 'button' }, [
    text,
    icon(ICONS.caret, 14),
  ]);
  toggle.querySelector('svg').classList.add('caret');
  const wrap = el('div', { class: 'ms' }, [toggle]);

  function paintToggle() {
    const list = [...chosen];
    if (!list.length) {
      text.textContent = placeholder;
      text.classList.add('placeholder');
    } else {
      text.textContent = list.length <= 2 ? list.join(', ') : `${list.length} selected`;
      text.classList.remove('placeholder');
    }
    toggle.title = list.join(', ');
  }

  function openList() {
    closeOpenPanel();
    const search = el('input', { type: 'search', placeholder: 'Search...', autocomplete: 'off' });
    const list = el('div', { class: 'ms-list' });
    const panel = el('div', { class: 'ms-panel' }, [
      el('div', { class: 'ms-search' }, [search]),
      list,
      el('div', { class: 'ms-foot' }, [
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Clear',
          onClick: () => { chosen = new Set(); paint(); paintToggle(); onChange?.([...chosen]); },
        }),
        el('button', {
          class: 'btn btn-sm btn-ghost',
          text: 'Done',
          onClick: closeOpenPanel,
        }),
      ]),
    ]);

    function paint() {
      const q = search.value.trim().toLowerCase();
      const shown = options.filter((o) => !q || o.toLowerCase().includes(q));
      list.replaceChildren();
      if (!shown.length) {
        list.append(el('div', { class: 'ms-none', text: options.length ? 'No match' : 'Nothing configured yet' }));
        return;
      }
      for (const opt of shown) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = chosen.has(opt);
        cb.addEventListener('change', () => {
          if (cb.checked) chosen.add(opt); else chosen.delete(opt);
          paintToggle();
          onChange?.([...chosen]);
        });
        list.append(el('label', {}, [cb, el('span', { text: opt })]));
      }
    }

    search.addEventListener('input', paint);
    paint();

    document.body.append(panel);
    const r = toggle.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    panel.style.width = `${width}px`;
    panel.style.left = `${Math.min(r.left, window.innerWidth - width - 12)}px`;
    const below = window.innerHeight - r.bottom;
    if (below < 260 && r.top > below) {
      panel.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      panel.style.top = `${r.bottom + 4}px`;
    }
    openPanel = panel;
    setTimeout(() => search.focus(), 20);
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openPanel) { closeOpenPanel(); return; }
    openList();
  });

  paintToggle();

  return {
    el: wrap,
    get: () => [...chosen],
    set: (values) => { chosen = new Set(values); paintToggle(); },
  };
}

export function todayISO() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
