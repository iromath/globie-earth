// The Local Culture tools: the site's own Thai cookbook, the food and
// foodways of the places it protects.
//
// api.cookbook_recipes (infra/schema/254_cookbook.sql) is a world-readable layer
// of the project's own cookbook, "Cookbook Version Kai & Shea". Its passages are
// embedded into the same flat api.embeddings space every other entity lives in,
// so search_local_culture is catalog_search narrowed to entity_type 'recipe'
// rather than a second search engine; get_recipe then returns the dish as
// structured fields - names, ingredients, numbered method and tips - while a
// search passage carries the same text flattened into one string.
// Both read through PostgREST, so the same RLS that scopes every other tool
// scopes these, and neither writes anything.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEmbeddingProvider } from '../embed.js';
import type { Caller } from '../identity.js';
import { get, rpc } from '../postgrest.js';
import { rerankConfig, rerankHits } from '../rerank.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult, closestLine } from './result.js';

/** One catalogue hit for a recipe. `similarity` is cosine similarity, 0..1. */
interface HitRow {
  entity_type: string;
  entity_id: string;
  title: string;
  content: string;
  similarity: number;
}

/**
 * One api.cookbook_recipes row. Free-text lists are jsonb in the table and
 * arrive here already parsed; `steps` is a list of numbered objects.
 */
interface RecipeRow {
  id: number;
  slug: string;
  name_en: string;
  name_local: string | null;
  name_thai: string | null;
  region: string | null;
  category: string;
  servings: string | null;
  total_minutes: number | null;
  description: string;
  ingredients: string[];
  steps: RecipeStep[];
  tips: string[];
  source: string;
  source_url: string | null;
  license: string;
  imported_at: string;
}

/**
 * One method step. `minutes` is the book's own per-step time: a number, a range
 * the book wrote as a string ("20-25"), or null where it gave none.
 */
interface RecipeStep {
  step: number;
  detail: string;
  minutes: number | string | null;
}

/** The columns a keyword match scans - enough to identify and summarise a dish. */
interface RecipeKeywordRow {
  id: number;
  slug: string;
  name_en: string;
  name_local: string | null;
  name_thai: string | null;
  region: string | null;
  category: string;
  description: string;
  ingredients: string[];
}

/** One keyword hit: a lexical match, so it carries its terms and a score. */
interface KeywordHit {
  entityType: 'recipe';
  entityId: string;
  slug: string;
  title: string;
  content: string;
  matchedTerms: string[];
  score: number;
}

/** How many recipes a search returns. Fixed, like the catalogue's signature. */
const SEARCH_RESULTS = 8;

/** The columns get_recipe reads back, so the tool and the table cannot drift. */
const RECIPE_COLUMNS =
  'id,slug,name_en,name_local,name_thai,region,category,servings,total_minutes,' +
  'description,ingredients,steps,tips,source,source_url,license,imported_at';

/**
 * Words too common to carry meaning in a keyword match, so a query like
 * "how do I cook the chicken" does not rank every dish that merely says
 * "the" or "do".
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'cook', 'do',
  'does', 'for', 'from', 'has', 'have', 'how', 'i', 'in', 'into', 'is', 'it',
  'its', 'make', 'me', 'my', 'of', 'on', 'or', 'recipe', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'this', 'to', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'you',
]);

/** The query's searchable terms: lowercased, one letter dropped, de-duplicated. */
function searchTerms(query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
  return Array.from(new Set(terms));
}

/** Which of the terms appear in a row's text, so a hit can show its evidence. */
function matchedTerms(text: string, terms: string[]): string[] {
  const haystack = text.toLowerCase();
  return terms.filter((term) => haystack.includes(term));
}

/** "Green Curry with Chicken (Gaeng Keow Wan Gai)" - the names a listener knows. */
function displayName(row: {
  name_en: string;
  name_local?: string | null;
  name_thai?: string | null;
}): string {
  // name_en sometimes already prints the romanised name in its own brackets
  // ("Green Curry with Chicken (Gaeng Keow Wan Gai)"), so a local or Thai name
  // that is already in it is not repeated - which is what turned the same dish
  // into "... (Gaeng Keow Wan Gai) (Gaeng Keow Wan Gai, Gaeng Keow Wan Gai)".
  const extra = [row.name_local, row.name_thai].filter(
    (name): name is string =>
      Boolean(name) && !row.name_en.toLowerCase().includes(name!.toLowerCase()),
  );
  return extra.length ? `${row.name_en} (${extra.join(', ')})` : row.name_en;
}

/**
 * A keyword search over the cookbook, used when no embedding provider is
 * configured. It matches the query's terms against the same text a passage
 * would have been built from and ranks by how many matched. That is a lexical
 * match, not a vector one, so the payload labels it as such rather than
 * reporting a cosine similarity it did not compute. The cookbook is small (a
 * few dozen dishes), so it is read whole and matched here.
 */
async function keywordSearch(query: string, caller: Caller): Promise<KeywordHit[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];

  const rows = await get<RecipeKeywordRow[]>(
    'cookbook_recipes?select=id,slug,name_en,name_local,name_thai,region,category,description,ingredients',
    caller,
  );

  const hits: KeywordHit[] = [];
  for (const row of rows) {
    const matched = matchedTerms(
      [
        row.name_en,
        row.name_local,
        row.name_thai,
        row.region,
        row.category,
        row.description,
        ...(row.ingredients ?? []),
      ]
        .filter(Boolean)
        .join(' '),
      terms,
    );
    if (matched.length) {
      hits.push({
        entityType: 'recipe',
        entityId: String(row.id),
        slug: row.slug,
        title: displayName(row),
        content: row.description,
        matchedTerms: matched,
        score: matched.length / terms.length,
      });
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, SEARCH_RESULTS);
}

/**
 * Resolves one dish from what a caller can actually supply: the id a search
 * returned, the slug, or the name as spoken ("green curry with chicken"). Tried
 * id, then slug, then a case-insensitive name match.
 */
async function findRecipe(recipe: string, caller: Caller): Promise<RecipeRow | null> {
  const trimmed = recipe.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) {
    const byId = await get<RecipeRow[]>(
      `cookbook_recipes?select=${RECIPE_COLUMNS}&id=eq.${trimmed}&limit=1`,
      caller,
    );
    if (byId.length) return byId[0];
  }

  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) {
    const bySlug = await get<RecipeRow[]>(
      `cookbook_recipes?select=${RECIPE_COLUMNS}&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      caller,
    );
    if (bySlug.length) return bySlug[0];
  }

  // PostgREST's `or=(...)` splits on parentheses, so a name that carries its
  // romanised form in its own brackets - "Green Curry with Chicken (Gaeng Keow
  // Wan Gai)", which is exactly what a search hit's title, and therefore what a
  // follow-up like "how do I cook it" refers back to, looks like - can never
  // match through it, and the recipe reads as missing. The bracket is a gloss a
  // name search does not need, so it is dropped here; URL-encoding it does not
  // help, because the query string is decoded before it is parsed.
  const named =
    trimmed
      .replace(/\s*[(\[][^)\]]*[)\]]\s*$/, '')
      .replace(/^["'“”]|["'“”]$/g, '')
      .trim() || trimmed;
  const encoded = encodeURIComponent(named);
  const byName = await get<RecipeRow[]>(
    `cookbook_recipes?select=${RECIPE_COLUMNS}` +
      `&or=(name_en.ilike.*${encoded}*,name_local.ilike.*${encoded}*)` +
      '&order=name_en.asc&limit=1',
    caller,
  );
  return byName[0] ?? null;
}

/**
 * The spoken line for one cookbook search hit.
 *
 * A semantic hit's `content` is the whole flattened recipe - the names, the
 * description, the entire ingredient list and every numbered step
 * (scripts/backfill-embeddings.mjs) - so reading it aloud runs past a thousand
 * characters and, on the book's longest dish, was cut off partway through step
 * three of seven, which sounds like a dropped line rather than an answer. The
 * search tool's job is to find the dish; the steps belong to get_recipe, which
 * returns them numbered and fits the mouth. So the summary keeps the name and
 * the description and stops where the ingredients begin. A keyword hit's
 * `content` is already just the description, so the split leaves it whole.
 */
function spokenHit(title: string, content: string): string {
  const brief =
    content.split(/\s+(?:Ingredients|Method|Tips)\s*:/i)[0]?.trim() || content.trim();
  return closestLine(title, brief);
}

export function registerCookbookTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'search_local_culture',
    {
      title: 'Search local culture - the Thai cookbook',
      description:
        'Search Globie Earth\'s Local Culture collection - the site\'s own Thai cookbook, ' +
        '"Cookbook Version Kai & Shea", the recipe book the project publishes about the food of ' +
        'the places it protects. Use this for any cooking or food-culture question: what a ' +
        'dish is, what goes into it, its ingredients, its region or category (dips, salads, ' +
        'soups, curries, noodles, stir-fries, steamed, grilled, fried, braises and the curry ' +
        'pastes), or which dishes use an ingredient such as galangal or Thai basil. Returns ' +
        'passages ranked by relevance, each with the recipe it belongs to - call get_recipe ' +
        'with the id or the dish name to read the whole ingredients list and method. The ' +
        '`ranking` field says how the order was produced: `reranked` when an AI pass reordered ' +
        'the candidates, `cosine` when it is the raw similarity order. When the server has no ' +
        'embedding provider configured it answers with keyword matches over the same text and ' +
        'says so. Read-only.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe(
            'A natural-language cooking question or keywords, e.g. "how do I make green curry" ' +
              'or "salad with peanuts".',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('search_local_culture') } },
    },
    async ({ query }) => {
      try {
        const provider = getEmbeddingProvider();

        // A keyword answer, labelled for what it is - a lexical match over the
        // same recipe text a vector would be built from, never a cosine
        // similarity that was not computed. Used both when semantic search is
        // switched off and when the configured provider is unusable, so the
        // tool always answers.
        const keywordAnswer = async (reason: string) => {
          const hits = await keywordSearch(query, caller);
          const spoken = hits.length
            ? `I found ${hits.length} ${hits.length === 1 ? 'recipe' : 'recipes'} for "${query}". The closest is ${spokenHit(hits[0].title, hits[0].content)} Ask "how do I cook it" for the steps. These are keyword matches over the cookbook text, not vector similarity.`
            : `I found no recipe for "${query}" in the cookbook. Try a plainer word or a dish name.`;
          return jsonResult(
            {
              query,
              method: 'keyword',
              embeddingModel: null,
              note: hits.length
                ? `${reason} These are keyword matches over the cookbook text, not vector similarity.`
                : `${reason} No recipe matched those keywords, so try a plainer word or a dish name.`,
              hits: hits.map((hit) => ({ ...hit })),
            },
            spoken,
            {
              resourceUri: uiUriForTool('search_local_culture'),
              invoking: 'Searching the cookbook…',
              invoked: 'Cookbook search',
            },
          );
        };

        if (!provider) {
          return keywordAnswer(
            'Semantic search is switched off on this server (EMBEDDING_PROVIDER=none).',
          );
        }

        let vector: number[];
        try {
          // `query` marks this as the question side of the pair: e5-class models
          // embed a question and a stored passage with different prefixes.
          vector = await provider.embed(query, 'query');
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'the embedding provider failed.';
          return keywordAnswer(`Semantic search is unavailable on this server (${reason}).`);
        }

        const rerank = rerankConfig();
        const hits = await rpc<HitRow[]>(
          'catalog_search',
          {
            // PostgREST casts the JSON string to the vector type (see api.ts).
            p_query: `[${vector.join(',')}]`,
            p_match_count: rerank.enabled ? rerank.pool : SEARCH_RESULTS,
            // The one narrowing that makes this the cookbook tool: the shared
            // search, restricted to the recipe passages (254_cookbook.sql).
            p_entity_type: 'recipe',
            // The raw text, so catalog_search can lift a dish whose name actually
            // matches the question instead of trusting cosine alone.
            p_query_text: query,
          },
          caller,
        );

        // Reorder the pool by how directly each passage answers the question.
        // The reranker only reorders rows the database returned; when it is off
        // or fails, the cosine order stands and `ranking` says so honestly.
        let ranked = hits;
        let ranking: 'reranked' | 'cosine' = 'cosine';
        let rerankModel: string | null = null;
        if (rerank.enabled && hits.length > 1) {
          const outcome = await rerankHits(query, hits, caller.latencyBudgetMs);
          if (outcome) {
            ranked = outcome.order.map((index) => hits[index]);
            ranking = 'reranked';
            rerankModel = outcome.model;
          }
        }
        const top = ranked.slice(0, SEARCH_RESULTS);

        const spoken = top.length
          ? `I found ${top.length} ${top.length === 1 ? 'recipe' : 'recipes'} for "${query}". The closest is ${spokenHit(top[0].title, top[0].content)} Ask "how do I cook it" for the steps.`
          : `I found no recipe in the cookbook for "${query}".`;

        return jsonResult(
          {
            query,
            method: 'semantic',
            embeddingModel: provider.model,
            // Which order the hits are in: `reranked` (an AI pass reordered the
            // candidates) or `cosine` (the raw similarity order). Stated so the
            // enhancement is never claimed when it did not run.
            ranking,
            rerankModel,
            hits: top.map((row) => ({
              entityType: row.entity_type,
              entityId: row.entity_id,
              title: row.title,
              content: row.content,
              similarity: row.similarity,
            })),
          },
          spoken,
          {
            resourceUri: uiUriForTool('search_local_culture'),
            invoking: 'Searching the cookbook…',
            invoked: 'Cookbook search',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'get_recipe',
    {
      title: 'Get a recipe',
      description:
        'Read one full recipe from Globie Earth\'s own Thai cookbook: its English, romanised ' +
        'and Thai names, its region and category, servings, total time, the complete ' +
        'ingredients list, the numbered method with the book\'s own per-step times, and its ' +
        'tips. Pass the id or slug a search_local_culture hit returned, or simply the dish name ' +
        'as spoken ("green curry with chicken"). Read-only.',
      inputSchema: {
        recipe: z
          .string()
          .min(1)
          .max(120)
          .describe(
            'The recipe to read: an id or slug from search_local_culture, or the dish name, ' +
              'e.g. "Pad Thai with Shrimp" or "som-tum-thai".',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('get_recipe') } },
    },
    async ({ recipe }) => {
      try {
        const row = await findRecipe(recipe, caller);
        if (!row) {
          return errorResult(
            `No recipe in the cookbook matches "${recipe}". Search first with ` +
              'search_local_culture, then pass back the id or dish name from a hit.',
          );
        }

        const time = row.total_minutes != null ? `about ${row.total_minutes} minutes` : null;
        const serves = row.servings ? `serves ${row.servings}` : null;
        // The method itself, not a count of it: "how do I cook it" is asking for
        // the steps, and "7 steps" answered the question with a number. Each step
        // carries the book's own time where it gave one, in the same shape
        // backfill-embeddings.mjs flattens into the searchable passage. A long
        // dish runs past what one breath can hold, so the spoken reply is left to
        // the host's own clipping (alexa.ts, SPEECH_LIMIT) rather than truncated
        // here, where the sentence boundary cannot be seen.
        const method = row.steps.length
          ? 'Step by step: ' +
            row.steps
              .map((step, index) => {
                const number = step.step ?? index + 1;
                const minutes =
                  step.minutes === null || step.minutes === undefined || step.minutes === ''
                    ? ''
                    : ` (about ${step.minutes} minutes)`;
                return `${number}. ${step.detail}${minutes}`;
              })
              .join(' ')
          : null;
        const summary = [
          displayName(row),
          `is a ${row.category}${row.region ? ` from ${row.region} Thailand` : ''}.`,
          serves ? `It ${serves}` : null,
          time ? `and takes ${time}.` : null,
          row.description,
          method,
        ]
          .filter(Boolean)
          .join(' ');

        return jsonResult(
          {
            id: String(row.id),
            slug: row.slug,
            nameEn: row.name_en,
            nameLocal: row.name_local,
            nameThai: row.name_thai,
            region: row.region,
            category: row.category,
            servings: row.servings,
            totalMinutes: row.total_minutes,
            description: row.description,
            ingredients: row.ingredients,
            steps: row.steps,
            tips: row.tips,
            // Provenance, so the answer is never passed off as generic web
            // content: this is the project's own book.
            source: row.source,
            sourceUrl: row.source_url,
            license: row.license,
          },
          summary,
          {
            resourceUri: uiUriForTool('get_recipe'),
            invoking: 'Reading the recipe…',
            invoked: displayName(row),
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
