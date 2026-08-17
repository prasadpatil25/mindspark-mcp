// SelfHostedStore — talks to a self-hosted MindSpark server's own REST API
// (see the "REST API" section of the main MindSpark README) instead of GitHub.
// Much simpler than GitHubStore: the self-hosted server already owns concurrency
// and index bookkeeping (SQLite `upsert()` on its side), so this is a thin,
// mostly stateless client — no shas, no separate index file, no merge-on-write.

export class SelfHostedStore {
  constructor({ baseUrl }) {
    if (!baseUrl) throw new Error('SelfHostedStore requires a baseUrl (MINDSPARK_SELF_HOSTED_URL)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async _fetch(path, opts = {}) {
    const r = await fetch(`${this.baseUrl}${path}`, opts);
    if (!r.ok && r.status !== 404) {
      const t = await r.text().catch(() => '');
      throw new Error(`${opts.method || 'GET'} ${path} failed (HTTP ${r.status}) ${t.slice(0, 140)}`);
    }
    return r;
  }

  // Returns [{id, title, color, updated}, ...] — same shape list_maps/get_map
  // callers already expect from GitHubStore's index.
  async listMaps() {
    const r = await this._fetch('/api/maps');
    return r.json();
  }

  async getMap(id) {
    const r = await this._fetch(`/api/maps/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    return r.json();
  }

  // PUT is an upsert on the self-hosted server (same handler backs POST /api/maps
  // and PUT /api/maps/:id — see server.js's upsert()), so create and update are
  // the same call here; no separate "does it already exist" check needed.
  async saveMap(map) {
    map.updated = Date.now();
    await this._fetch(`/api/maps/${encodeURIComponent(map.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(map)
    });
    return map;
  }

  async deleteMap(id) {
    await this._fetch(`/api/maps/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
