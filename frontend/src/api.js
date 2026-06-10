const TOKEN_KEY = 'dn42_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/** Decode (not verify — server does that) the JWT payload; null if absent/expired. */
export function getAuth() {
  const t = getToken();
  if (!t) return null;
  try {
    const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (payload.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function req(path, { method = 'GET', body, admin } = {}) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (admin) headers['x-admin-token'] = admin;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  info: () => req('/info'),
  nodes: () => req('/nodes'),

  lookup: (asn) => req('/auth/lookup', { method: 'POST', body: { asn } }),
  challenge: (asn, methodIndex) => req('/auth/challenge', { method: 'POST', body: { asn, methodIndex } }),
  verify: (challengeId, signature, publicKey) => req('/auth/verify', { method: 'POST', body: { challengeId, signature, publicKey } }),

  myPeerings: () => req('/peerings'),
  createPeering: (body) => req('/peerings', { method: 'POST', body }),
  updatePeering: (id, body) => req(`/peerings/${id}`, { method: 'PATCH', body }),
  deletePeering: (id) => req(`/peerings/${id}`, { method: 'DELETE' }),
  peeringStatus: (id) => req(`/peerings/${id}/status`),

  admin: {
    peerings: (t) => req('/admin/peerings', { admin: t }),
    action: (t, id, action) => req(`/admin/peerings/${id}/${action}`, { method: 'POST', admin: t }),
    remove: (t, id) => req(`/admin/peerings/${id}`, { method: 'DELETE', admin: t }),
    nodesHealth: (t) => req('/admin/nodes/health', { admin: t }),
    events: (t) => req('/admin/events?limit=200', { admin: t }),
  },
};
