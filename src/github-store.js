// GitHubStore — talks to a user's own `mindspark-maps` GitHub repo, the exact same
// repo and file layout the MindSpark web app's CloudStore uses (public/app.js).
// Deliberately mirrors CloudStore's logic line-for-line where the environment allows
// (Node's Buffer instead of btoa/atob, no localStorage) so a map created or edited
// through this MCP server round-trips through the real app with no surprises, and a
// concurrent web-app save can never silently clobber an MCP write or vice versa.
//
// Repo layout (must match public/app.js's CloudStore exactly):
//   _index.json    — array of {id, title, color, updated, pinned?} summaries
//   _deleted.json  — array of tombstoned map ids (never resurrect a deleted map)
//   maps/{id}.json — one full map object per file

const API = 'https://api.github.com';

export class GitHubStore {
  constructor({ token, owner, repo = 'mindspark-maps' }) {
    if (!token) throw new Error('GitHubStore requires a GitHub token (repo scope, or fine-grained with Contents read/write on mindspark-maps)');
    this.token = token;
    this.owner = owner;   // resolved lazily via whoami() if not provided
    this.repo = repo;
    this.shas = {};       // map id -> current file sha, for optimistic-concurrency writes
    this.indexSha = null;
    this.deletedSha = null;
  }

  _headers() {
    return {
      Authorization: `token ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }
  _encode(s) { return Buffer.from(s, 'utf8').toString('base64'); }
  _decode(s) { return Buffer.from(s.replace(/\n/g, ''), 'base64').toString('utf8'); }

  async whoami() {
    const r = await fetch(`${API}/user`, { headers: this._headers() });
    if (!r.ok) throw new Error(`Invalid GitHub token (HTTP ${r.status})`);
    const u = await r.json();
    this.owner = u.login;
    return u;
  }

  async ensureRepo() {
    if (!this.owner) await this.whoami();
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}`, { headers: this._headers() });
    if (r.status === 404) {
      const cr = await fetch(`${API}/user/repos`, {
        method: 'POST',
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.repo, description: 'My MindSpark mind maps', private: true, auto_init: true })
      });
      if (!cr.ok) {
        const t = await cr.text();
        throw new Error(
          `Could not create the "${this.repo}" repository (HTTP ${cr.status}). Two likely causes: ` +
          `(1) your fine-grained token doesn't have the "Administration: Read and write" permission — ` +
          `this is separate from "Contents" and is specifically required to create a new repository; or ` +
          `(2) "${this.repo}" already exists under your account but this token isn't scoped to it, so GitHub ` +
          `can't see it and this looks like it's missing. Easiest fix: create the "${this.repo}" repository ` +
          `yourself first (private, empty) at github.com/new, then scope your token to just that one repo with ` +
          `"Contents: Read and write" — no Administration permission needed at all once the repo already exists. ` +
          `See README.md. Raw response: ${t.slice(0, 140)}`
        );
      }
      await new Promise(res => setTimeout(res, 800));   // GitHub needs a moment before the repo is writable
    } else if (!r.ok) {
      throw new Error(`Could not access repo (HTTP ${r.status})`);
    }
  }

  async _fetchIndexRaw() {
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/_index.json`, { headers: this._headers() });
    if (r.status === 404) { this.indexSha = null; return []; }
    if (!r.ok) throw new Error(`Could not load index (HTTP ${r.status})`);
    const data = await r.json();
    this.indexSha = data.sha;
    try { const a = JSON.parse(this._decode(data.content)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }

  async _loadDeleted() {
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/_deleted.json`, { headers: this._headers() });
    if (!r.ok) { this.deletedSha = null; return []; }
    const data = await r.json();
    this.deletedSha = data.sha;
    try { const a = JSON.parse(this._decode(data.content)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }

  async _writeFile(path, content, sha) {
    const body = { message: `MindSpark MCP: update ${path}`, content: this._encode(content) };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`, {
      method: 'PUT', headers: { ...this._headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) {
      if (r.status === 409 || r.status === 422) {   // stale sha — refresh once and retry, same as CloudStore
        const gh = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`, { headers: this._headers() });
        if (gh.ok) {
          const d = await gh.json();
          body.sha = d.sha;
          const retry = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/${path}`, {
            method: 'PUT', headers: { ...this._headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body)
          });
          if (retry.ok) { const dat = await retry.json(); return dat.content.sha; }
        }
      }
      const t = await r.text();
      throw new Error(`Write ${path} failed (HTTP ${r.status}) ${t.slice(0, 140)}`);
    }
    const data = await r.json();
    return data.content.sha;
  }

  async _deleteFile(path, sha) {
    const url = `${API}/repos/${this.owner}/${this.repo}/contents/${path}`;
    const del = s => fetch(url, { method: 'DELETE', headers: { ...this._headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `MindSpark MCP: delete ${path}`, sha: s }) });
    let r = await del(sha);
    if (r.ok || r.status === 404) return;
    if (r.status === 409 || r.status === 422) {
      const gh = await fetch(url, { headers: this._headers() });
      if (gh.status === 404) return;
      if (gh.ok) { const d = await gh.json(); const r2 = await del(d.sha); if (r2.ok || r2.status === 404) return; r = r2; }
    }
    throw new Error(`Delete ${path} failed (HTTP ${r.status})`);
  }

  // Merge-on-write, identical to CloudStore._saveIndex — re-reads the live index and
  // overlays in-memory entries so a save here can never clobber an entry the web app
  // (or another MCP call) wrote a moment ago; only an explicit delete removes one.
  async _saveIndex(localIndex, deletedIds) {
    let server = [];
    try { server = await this._fetchIndexRaw(); } catch (e) { server = localIndex.slice(); }
    const byId = new Map(server.map(m => [m.id, m]));
    for (const m of localIndex) byId.set(m.id, m);
    for (const id of deletedIds) byId.delete(id);
    const merged = [...byId.values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    this.indexSha = await this._writeFile('_index.json', JSON.stringify(merged), this.indexSha);
    return merged;
  }

  async listMaps() {
    await this.ensureRepo();
    return this._fetchIndexRaw();
  }

  async getMap(id) {
    await this.ensureRepo();
    const r = await fetch(`${API}/repos/${this.owner}/${this.repo}/contents/maps/${id}.json`, { headers: this._headers() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Could not load map (HTTP ${r.status})`);
    const data = await r.json();
    this.shas[id] = data.sha;
    const inlined = data.content && data.content.trim() && data.encoding !== 'none';
    const json = inlined ? this._decode(data.content) : await this._readLargeBlob(data);
    return JSON.parse(json);
  }

  // Contents API only inlines files up to 1MB — same fallback chain as CloudStore.
  async _readLargeBlob(data) {
    if (data.git_url) {
      const br = await fetch(data.git_url, { headers: this._headers() });
      if (br.ok) { const blob = await br.json(); if (blob && blob.content) return this._decode(blob.content); }
    }
    if (data.download_url) {
      const dr = await fetch(data.download_url, { headers: this._headers() });
      if (dr.ok) return await dr.text();
    }
    throw new Error('Could not read large map content (Blobs API + raw both failed)');
  }

  // Saves one map file, then merges it into the index — mirrors CloudStore.save exactly.
  async saveMap(map) {
    await this.ensureRepo();
    map.updated = Date.now();
    this.shas[map.id] = await this._writeFile(`maps/${map.id}.json`, JSON.stringify(map), this.shas[map.id]);
    const entry = { id: map.id, title: map.title, color: map.color, updated: map.updated };
    if (map.pinned) entry.pinned = true;
    const index = await this._fetchIndexRaw();
    const i = index.findIndex(m => m.id === map.id);
    if (i >= 0) index[i] = entry; else index.unshift(entry);
    await this._saveIndex(index, []);
    return map;
  }

  async deleteMap(id) {
    await this.ensureRepo();
    try { await this._deleteFile(`maps/${id}.json`, this.shas[id]); }
    catch (e) { /* file may already be gone — proceed to tombstone regardless */ }
    delete this.shas[id];
    const deleted = await this._loadDeleted();
    if (!deleted.includes(id)) deleted.push(id);
    this.deletedSha = await this._writeFile('_deleted.json', JSON.stringify(deleted), this.deletedSha);
    const index = await this._fetchIndexRaw();
    await this._saveIndex(index.filter(m => m.id !== id), [id]);
  }
}
