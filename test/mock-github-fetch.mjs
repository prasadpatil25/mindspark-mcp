// Minimal mock of the GitHub Contents API, for tests that spawn the real server as a
// child process and need `fetch` mocked inside THAT process (env vars can't inject a
// fetch mock, so this is loaded via `node --import`).
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const j = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  if (u.pathname === '/user') return j(200, { login: 'testuser' });
  if (/\/repos\/testuser\/mindspark-maps$/.test(u.pathname)) return j(200, {});

  const m = u.pathname.match(/\/repos\/testuser\/mindspark-maps\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    globalThis.__files = globalThis.__files || new Map();
    if (method === 'GET') {
      const f = globalThis.__files.get(path);
      if (!f) return j(404, {});
      return j(200, { content: Buffer.from(f.content).toString('base64'), sha: f.sha, encoding: 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const sha = 'sha' + Math.random().toString(36).slice(2);
      globalThis.__files.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return j(200, { content: { sha } });
    }
  }
  throw new Error('unhandled mock fetch: ' + method + ' ' + url);
};
