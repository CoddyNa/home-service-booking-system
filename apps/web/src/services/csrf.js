import { apiUrl } from './api';

let pendingToken;

export function getCsrfToken(forceRefresh = false) {
  if (forceRefresh || !pendingToken) {
    let request;
    request = fetch(apiUrl('/api/csrf-token'), { credentials: 'include', cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error('Could not start a secure session.');
        return response.json();
      })
      .then((data) => {
        if (!data.csrfToken) throw new Error('The server did not provide a CSRF token.');
        return data.csrfToken;
      })
      .catch(() => {
        if (pendingToken === request) pendingToken = undefined;
        return '';
      });
    pendingToken = request;
  }
  return pendingToken;
}

export function rememberCsrfToken(token) {
  if (typeof token === 'string' && token) pendingToken = Promise.resolve(token);
}

export async function csrfFetch(url, options = {}) {
  let token = await getCsrfToken();
  if (!token) throw new Error('Could not start a secure session. Refresh the page and try again.');

  const send = (csrfToken) => fetch(apiUrl(url), {
    ...options,
    credentials: 'include',
    headers: { ...options.headers, 'X-CSRF-Token': csrfToken },
  });

  let response = await send(token);
  if (response.status !== 403) return response;

  const body = await response.clone().json().catch(() => null);
  if (body?.error !== 'Invalid CSRF token') return response;

  token = await getCsrfToken(true);
  if (!token) return response;
  response = await send(token);
  return response;
}
