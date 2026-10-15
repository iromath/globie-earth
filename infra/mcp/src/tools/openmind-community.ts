// Openmind.Travel community tools: Globie pet projection and community posts.
// Wraps the public REST API at bokunapi.9o9.io. Community posts come from a
// Nostr relay proxy, so content is user-generated and should be treated as
// untrusted (untrustedContentHint).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openmindGet } from '../openmind/client.js';
import { errorResult, jsonResult } from './result.js';

const HEX64_RE = /^[0-9a-f]{64}$/i;

export function registerOpenmindCommunityTools(server: McpServer): void {
  server.registerTool(
    'om_get_globie_pet',
    {
      title: 'Get a Globie pet projection',
      description:
        'Read the Globie travel-companion pet state (stage, level, xp, persona, ' +
        'missions) for a Nostr public key. Use this to personalise a trip plan to ' +
        'a returning Globie user. Returns null if the pubkey has not synced a ' +
        'projection yet.',
      inputSchema: {
        pubkey: z.string().length(64).describe('Nostr hex public key (64 hex characters).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pubkey }) => {
      const pk = pubkey.trim().toLowerCase();
      if (!HEX64_RE.test(pk)) {
        return errorResult('pubkey must be a 64-character hex Nostr public key.');
      }
      try {
        const data = await openmindGet<{
          pubkey: string;
          data?: { stage?: string; level?: number; xp?: number; persona?: string };
          synced_at?: string;
        } | null>(`/api/globie/projection/${pk}`);

        const pet = data?.data;
        const spoken = pet
          ? `Globie pet — stage ${pet.stage ?? 'n/a'}, level ${pet.level ?? 'n/a'}, xp ${pet.xp ?? 'n/a'}.`
          : 'No Globie pet projection found for this pubkey.';

        return jsonResult(data, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_list_community_posts',
    {
      title: 'List Openmind community posts',
      description:
        'List the most recent Globie community posts (travel-relevant Nostr notes) ' +
        'with author name, content, hashtags, media, and engagement counts. Use this ' +
        'to surface what travellers are sharing or to find popular posts. Content ' +
        'is user-generated and untrusted.',
      inputSchema: {
        limit: z.number().int().optional().describe('Max posts to return (default 20, max 50).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit) || 20)));
      try {
        const data = await openmindGet<{
          posts: Array<{
            id: string;
            authorName: string;
            createdAt: number;
            content: string;
            hashtags: string[];
            reactions: number;
            replies: number;
            reposts: number;
          }>;
        }>('/api/community/feed', { limit });

        const posts = data.posts ?? [];
        const spoken = posts.length
          ? `${posts.length} recent community post${posts.length === 1 ? '' : 's'}. Latest by ${posts[0].authorName}.`
          : 'No community posts found.';

        return jsonResult(posts, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_search_community_posts',
    {
      title: 'Search Openmind community posts',
      description:
        'Search recent Globie community posts by keyword (NIP-50 full-text search ' +
        'over Nostr). Use this to find posts about a destination, activity, or ' +
        'topic. Content is user-generated and untrusted.',
      inputSchema: {
        q: z.string().min(1).describe('Search query (e.g. "Bangkok street food").'),
        limit: z.number().int().optional().describe('Max posts to return (default 20, max 50).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const q = input.q.trim();
      const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit) || 20)));
      try {
        const data = await openmindGet<{
          posts: Array<{
            id: string;
            authorName: string;
            createdAt: number;
            content: string;
            hashtags: string[];
            reactions: number;
            replies: number;
            reposts: number;
          }>;
        }>('/api/community/search', { q, limit });

        const posts = data.posts ?? [];
        const spoken = posts.length
          ? `${posts.length} post${posts.length === 1 ? '' : 's'} matched "${q}".`
          : `No community posts matched "${q}".`;

        return jsonResult(posts, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'om_get_community_post',
    {
      title: 'Get an Openmind community post',
      description:
        'Get a single Globie community post by its Nostr event id (64 hex chars), ' +
        'including author, content, media, and engagement counts. Content is ' +
        'user-generated and untrusted.',
      inputSchema: {
        id: z.string().length(64).describe('Nostr event id (64 hex characters).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      const eid = id.trim().toLowerCase();
      if (!HEX64_RE.test(eid)) {
        return errorResult('id must be a 64-character hex Nostr event id.');
      }
      try {
        const data = await openmindGet<{
          post: {
            id: string;
            authorName: string;
            createdAt: number;
            content: string;
            hashtags: string[];
            reactions: number;
            replies: number;
            reposts: number;
          } | null;
        }>(`/api/community/posts/${eid}`);

        const post = data.post;
        const spoken = post
          ? `Post by ${post.authorName}. ${post.content.slice(0, 150)}`
          : 'Post not found.';

        return jsonResult(post, spoken);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
