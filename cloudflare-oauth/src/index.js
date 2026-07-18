import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { GitHubHandler } from './github-handler.js';
import { McpApiHandler } from './mcp-api-handler.js';

export default new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: McpApiHandler,
  defaultHandler: GitHubHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  // MCP tool calls are the only thing this server protects — no separate scope
  // model beyond "you're a GitHub-authenticated MindSpark user."
  scopesSupported: ['mcp']
});
