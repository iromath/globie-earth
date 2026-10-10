// The caller's own Living Deeds, as a resource.
//
// me/deeds is the read-only mirror of the get_my_deeds tool: the same rows,
// through the same shared read (src/deeds.ts). Unlike the catalogue resources,
// this one is device-scoped - the RLS policies pin api.living_deeds to
// private.device_id() - so it is served per session, against the caller the
// transport was opened with, and holds no cross-device data.
//
// The uri carries the globie:// scheme because the MCP SDK runs `new URL()` on
// a resource uri before dispatch, so a bare `me/deeds` throws and surfaces as
// JSON-RPC -32603; `globie://me/deeds` is absolute and round-trips.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { listDeeds, toDeed } from '../deeds.js';
import type { Caller } from '../identity.js';

export function registerDeedResources(server: McpServer, caller: Caller): void {
  server.registerResource(
    'me/deeds',
    'globie://me/deeds',
    {
      title: 'My living deeds',
      description: 'The Living Deeds issued for adoptions made by this caller, newest first.',
      mimeType: 'application/json',
    },
    async (uri): Promise<ReadResourceResult> => {
      const rows = await listDeeds(caller);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                count: rows.length,
                deeds: rows.map(toDeed),
                // An empty list is a real state, not a failure - say which one it is.
                note: rows.length ? null : 'This device has not adopted anything yet.',
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
