const TOKEN_KEY = 'field-ledger:token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

export class ApiError extends Error {
  constructor(message, { status = 0, offline = false, body = null } = {}) {
    super(message);
    this.status = status;
    this.offline = offline;
    this.body = body;
  }
}

async function request(path, { method = 'GET', body, formData, signal } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: formData || (body !== undefined ? JSON.stringify(body) : undefined),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('No connection. Your entry is saved on this phone and will sync when signal returns.', { offline: true });
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (res.status === 401 && !path.startsWith('/auth/')) {
    setToken(null);
    window.dispatchEvent(new Event('field-ledger:unauthorized'));
  }

  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status}).`, { status: res.status, body: data });
  }
  return data;
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
  upload: (path, formData, opts) => request(path, { ...opts, method: 'POST', formData }),
  url: (path) => `/api${path}`,
};

/** Streams an export through the auth header and hands the browser the file. */
export async function downloadExport(report, params = {}, format = 'xlsx') {
  const qs = new URLSearchParams({ ...params, format }).toString();
  const res = await fetch(`/api/export/${report}?${qs}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = `Export failed (${res.status}).`;
    try { msg = JSON.parse(text)?.error || msg; } catch { /* html error page */ }
    throw new ApiError(msg, { status: res.status });
  }
  const blob = await res.blob();
  const disp = res.headers.get('content-disposition') || '';
  const filename = /filename="([^"]+)"/.exec(disp)?.[1] || `field-ledger-${report}.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return filename;
}

/** Probe used to notice when signal comes back. */
export async function ping() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
