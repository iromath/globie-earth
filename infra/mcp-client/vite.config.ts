import { defineConfig } from 'vite';

// A plain Vite app with no framework: the point of this page is the MCP client
// in src/mcp.ts, not a UI stack. The dev port matches the MCP server's default
// MCP_CORS_ORIGINS (http://localhost:5173), so `npm run dev` works against a
// local server with no configuration.
export default defineConfig({
  server: { port: 5173, host: '0.0.0.0' },
  preview: { port: 4173, host: '0.0.0.0' },
});
