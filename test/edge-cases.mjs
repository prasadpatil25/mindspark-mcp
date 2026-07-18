import { GitHubStore } from '../src/github-store.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail||''}`); } }

console.log('=== Repo does not exist yet: ensureRepo creates it ===');
{
  let created = false;
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    if (u.pathname === '/user') return ok({ login: 'newuser' });
    if (u.pathname === '/repos/newuser/mindspark-maps' && method === 'GET') return ok404();
    if (u.pathname === '/user/repos' && method === 'POST') { created = true; return ok({ name: 'mindspark-maps' }); }
    throw new Error('unexpected: ' + method + ' ' + url);
  };
  const store = new GitHubStore({ token: 't', repo: 'mindspark-maps' });
  await store.ensureRepo();
  check('repo creation was called', created);
}

console.log('\n=== Stale sha on write (409): retries once with fresh sha ===');
{
  let writeAttempts = 0;
  const files = new Map([['maps/abc.json', { content: '{"old":true}', sha: 'sha-old' }]]);
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    if (u.pathname === '/user') return ok({ login: 'u' });
    if (u.pathname === '/repos/u/mindspark-maps') return ok({});
    const m = u.pathname.match(/\/contents\/(.+)$/);
    if (m && method === 'PUT') {
      writeAttempts++;
      const body = JSON.parse(opts.body);
      if (writeAttempts === 1) return ok409();   // simulate someone else wrote in between
      const sha = 'sha-new';
      files.set(m[1], { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return ok({ content: { sha } });
    }
    if (m && method === 'GET') {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f) return ok404();
      return ok({ content: Buffer.from(f.content).toString('base64'), sha: f.sha, encoding: 'base64' });
    }
    throw new Error('unexpected: ' + method + ' ' + url);
  };
  const store = new GitHubStore({ token: 't', repo: 'mindspark-maps' });
  const sha = await store._writeFile('maps/abc.json', '{"new":true}', 'sha-stale');
  check('write succeeded after retry', sha === 'sha-new', sha);
  check('two attempts were made (first 409, then success)', writeAttempts === 2, writeAttempts);
}

console.log('\n=== Concurrent index write (web app + MCP): merge-on-write never drops entries ===');
{
  let indexFile = { content: JSON.stringify([{ id: 'existing-map', title: 'From the web app', updated: 1000 }]), sha: 'sha1' };
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = opts.method || 'GET';
    if (u.pathname === '/user') return ok({ login: 'u' });
    if (u.pathname === '/repos/u/mindspark-maps') return ok({});
    if (/_index\.json$/.test(u.pathname) && method === 'GET') return ok({ content: Buffer.from(indexFile.content).toString('base64'), sha: indexFile.sha, encoding: 'base64' });
    if (/_index\.json$/.test(u.pathname) && method === 'PUT') {
      const body = JSON.parse(opts.body);
      indexFile = { content: Buffer.from(body.content, 'base64').toString('utf8'), sha: 'sha2' };
      return ok({ content: { sha: 'sha2' } });
    }
    throw new Error('unexpected: ' + method + ' ' + url);
  };
  const store = new GitHubStore({ token: 't', repo: 'mindspark-maps' });
  const merged = await store._saveIndex([{ id: 'mcp-created-map', title: 'From MCP', updated: 2000 }], []);
  const ids = merged.map(m => m.id);
  check('both the pre-existing web-app entry and the new MCP entry survive', ids.includes('existing-map') && ids.includes('mcp-created-map'), ids.join(','));
}

function ok(body) { return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }; }
function ok404() { return { ok: false, status: 404, json: async () => ({}), text: async () => '{}' }; }
function ok409() { return { ok: false, status: 409, json: async () => ({}), text: async () => '{}' }; }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
