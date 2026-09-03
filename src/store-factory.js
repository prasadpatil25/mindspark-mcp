// Picks a store implementation from environment variables — shared by the
// stdio entry (server.js) and the HTTP entry (http-server.js) so the two
// transports can't silently drift apart on which env vars they honor.
//
// MINDSPARK_SELF_HOSTED_URL and MINDSPARK_GH_TOKEN are mutually exclusive:
// self-hosted mode is checked first since it's the simpler, more explicit
// opt-in (a URL you control), and doesn't require a GitHub account at all.
import { GitHubStore } from './github-store.js';
import { SelfHostedStore } from './self-hosted-store.js';

export function resolveStoreFromEnv(env = process.env) {
  const selfHostedUrl = env.MINDSPARK_SELF_HOSTED_URL;
  if (selfHostedUrl) return new SelfHostedStore({ baseUrl: selfHostedUrl });

  const token = env.MINDSPARK_GH_TOKEN;
  if (token) return new GitHubStore({ token, repo: env.MINDSPARK_GH_REPO || 'mindspark-maps' });

  throw new Error(
    'Neither MINDSPARK_SELF_HOSTED_URL nor MINDSPARK_GH_TOKEN is set. ' +
    'Set MINDSPARK_SELF_HOSTED_URL to your self-hosted MindSpark server\'s base URL ' +
    '(e.g. http://localhost:3000), or MINDSPARK_GH_TOKEN to a GitHub token scoped to ' +
    'a "mindspark-maps" repo. See README.md.'
  );
}
