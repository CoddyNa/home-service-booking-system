const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');

export function apiUrl(path) {
  const apiPath = String(path).startsWith('/api/') ? String(path).slice(4) : String(path);
  return `${configuredApiBase}${apiPath.startsWith('/') ? apiPath : `/${apiPath}`}`;
}

export function apiFetch(path, options = {}) {
  return fetch(apiUrl(path), { credentials: 'include', ...options });
}
