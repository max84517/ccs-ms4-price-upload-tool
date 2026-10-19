// Thin wrapper around the backend API.

async function handle(res) {
  if (res.ok) return res.status === 204 ? null : res.json();
  let detail = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body && body.detail) {
      detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail);
    }
  } catch { /* keep the status text */ }
  throw new Error(detail);
}

export const api = {
  get: (url) => fetch(url).then(handle),

  post: (url, body) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then(handle),

  put: (url, body) =>
    fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }).then(handle),

  del: (url) => fetch(url, { method: 'DELETE' }).then(handle),

  upload: (url, file, fields = {}) => {
    const form = new FormData();
    form.append('file', file);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return fetch(url, { method: 'POST', body: form }).then(handle);
  },
};

function filenameFrom(res, fallback) {
  const header = res.headers.get('X-Generated-Filename');
  if (header) {
    try { return decodeURIComponent(header); } catch { /* fall through */ }
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const match = /filename="([^"]+)"/.exec(cd);
  return match ? match[1] : fallback;
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/**
 * POST that normally answers with a file. The backend answers with JSON instead
 * when something has to be shown to the user first (unmatched vendors, bad
 * prices), so the caller gets either {file: name} or {problem: payload}.
 */
export async function postForFile(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok) {
    await handle(res);
    return null;
  }
  if (type.includes('application/json')) {
    return { problem: await res.json() };
  }
  const blob = await res.blob();
  const filename = filenameFrom(res, 'download');
  saveBlob(blob, filename);
  return { file: filename };
}

export async function downloadFile(url, fallback = 'download') {
  const res = await fetch(url);
  if (!res.ok) {
    await handle(res);
    return null;
  }
  const blob = await res.blob();
  const filename = filenameFrom(res, fallback);
  saveBlob(blob, filename);
  return filename;
}
