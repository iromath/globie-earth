// Catalogue tools: semantic search and species recommendation.
//
// Both wrap the existing catalog_search and recommend_species RPCs and return
// the same facts the app's src/lib/api.ts reads - no new claims, no invented
// data. Each result is scoped to the caller by the identity forwarded in
// postgrest.ts, not by anything the caller can pass in.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getEmbeddingProvider } from '../embed.js';
import type { Caller } from '../identity.js';
import { get, rpc } from '../postgrest.js';
import { rerankConfig, rerankHits } from '../rerank.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult, closestLine } from './result.js';

/** One catalogue hit. `similarity` is cosine similarity, 0..1. */
interface HitRow {
  entity_type: string;
  entity_id: string;
  title: string;
  content: string;
  similarity: number;
}

interface RecommendationRow {
  species_id: string;
  name: string;
  tagline: string;
  similarity: number;
}

/** How many passages a search returns. Fixed, because the plan's signature is. */
const SEARCH_RESULTS = 8;

/** The catalogue columns a keyword search matches over, one shape per entity. */
interface SpeciesKeywordRow {
  id: string;
  name: string;
  botanical: string;
  tagline: string;
  description: string;
}

interface GuardianKeywordRow {
  id: string;
  name: string;
  thai_name: string;
  scientific_name: string;
  title: string;
  epithet: string;
  quote: string;
}

interface SiteKeywordRow {
  id: number;
  title: string;
  sub_sector: string;
  description: string;
}

/** One api.dnp_species row (the dnp_species table). */
interface DnpKeywordRow {
  id: number;
  scientific_name: string | null;
  thai_name: string | null;
  family: string | null;
  protected_area: string;
  forest_type: string | null;
  group_type: string;
}

/**
 * One api.dnp_plants row (the dnp_plants table). A checklist entry
 * has no location or year; its English name comes from GBIF and is null when
 * GBIF documents none.
 */
interface DnpPlantKeywordRow {
  id: number;
  scientific_name: string;
  thai_name: string | null;
  family: string | null;
  english_name: string | null;
  genus: string | null;
  synonyms: string | null;
  native_status: string | null;
  // Enriched from GBIF: the Red List category,
  // the number of Thai occurrence records and the provinces they fall in.
  iucn_status: string | null;
  th_record_count: number | null;
  th_provinces: string | null;
}

/**
 * One api.dnp_fauna row (the dnp_fauna table) - a species observed
 * inside a national park, with the park it was recorded in.
 */
interface DnpFaunaKeywordRow {
  id: number;
  scientific_name: string | null;
  thai_name: string | null;
  group_type: string | null;
  protected_area: string;
  protected_area_en: string | null;
  family: string | null;
  genus: string | null;
  iucn_status: string | null;
}

/**
 * One api.dnp_wildlife row (the dnp_wildlife table) - the national
 * checklist, with the statutory protected/reserved flags.
 */
interface DnpWildlifeKeywordRow {
  id: number;
  scientific_name: string;
  thai_name: string | null;
  english_name: string | null;
  group_type: string;
  family: string | null;
  is_reserved: boolean;
  is_protected: boolean;
  iucn_status: string | null;
}

/**
 * One keyword hit: a lexical match, not a vector one, so it carries the terms
 * it matched and a coverage score rather than a cosine similarity.
 */
interface KeywordHit {
  entityType:
    | 'species'
    | 'guardian'
    | 'site'
    | 'dnp_species'
    | 'dnp_plant'
    | 'dnp_fauna'
    | 'dnp_wildlife';
  entityId: string;
  title: string;
  content: string;
  matchedTerms: string[];
  score: number;
}

/**
 * Words too common to carry meaning in a keyword match. Without this, a query
 * like "guardian of the creek" ranks entities that merely contain "of" or
 * "the" above the creek guardian, which reads as a broken search.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'do', 'does', 'for',
  'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this', 'to', 'was',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with',
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

/**
 * A keyword search over the catalogue tables, used when no embedding provider
 * is configured. It matches the query's terms against the same text the
 * catalogue renders and ranks by how many terms matched. That is a lexical
 * match, not a vector one, so the payload labels it as such rather than
 * reporting a cosine similarity it did not compute.
 */
async function keywordSearch(
  query: string,
  entityType:
    | 'species'
    | 'guardian'
    | 'site'
    | 'dnp_species'
    | 'dnp_plant'
    | 'dnp_fauna'
    | 'dnp_wildlife'
    | undefined,
  caller: Caller,
): Promise<KeywordHit[]> {
  const terms = searchTerms(query);
  if (!terms.length) return [];

  const hits: KeywordHit[] = [];

  if (!entityType || entityType === 'species') {
    const rows = await get<SpeciesKeywordRow[]>(
      'species?select=id,name,botanical,tagline,description',
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [row.name, row.botanical, row.tagline, row.description].join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'species',
          entityId: row.id,
          title: row.name,
          content: row.description || row.tagline,
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'guardian') {
    const rows = await get<GuardianKeywordRow[]>(
      'guardians?select=id,name,thai_name,scientific_name,title,epithet,quote',
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [row.name, row.thai_name, row.scientific_name, row.title, row.epithet, row.quote].join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'guardian',
          entityId: row.id,
          title: row.name,
          content: row.quote || row.epithet,
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'site') {
    const rows = await get<SiteKeywordRow[]>(
      'sites?select=id,title,sub_sector,description',
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [row.title, row.sub_sector, row.description].join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'site',
          entityId: String(row.id),
          title: row.title,
          content: row.description,
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'dnp_species') {
    // The survey is ~61k rows, so the match is pushed down to Postgres as a
    // trigram ILIKE `or` (dnp_species_scientific_trgm_idx / _thai_trgm_idx, the
    // dnp_species table) rather than fetched whole and filtered here, and the
    // page is bounded. Terms are capped so the url filter cannot grow without
    // limit.
    const columns = ['scientific_name', 'thai_name', 'family', 'protected_area', 'forest_type'];
    const filters = terms
      .slice(0, 4)
      .flatMap((term) => columns.map((col) => `${col}.ilike.*${encodeURIComponent(term)}*`))
      .join(',');
    const rows = await get<DnpKeywordRow[]>(
      'dnp_species?select=id,scientific_name,thai_name,family,protected_area,forest_type,group_type' +
        `&or=(${filters})&limit=${SEARCH_RESULTS * 4}`,
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [
          row.scientific_name,
          row.thai_name,
          row.family,
          row.protected_area,
          row.forest_type,
          row.group_type,
        ]
          .filter(Boolean)
          .join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'dnp_species',
          entityId: String(row.id),
          title: row.scientific_name || row.thai_name || String(row.id),
          content: [
            row.scientific_name,
            row.thai_name && `(${row.thai_name})`,
            `Found in ${row.protected_area}.`,
            row.forest_type && `${row.forest_type} forest.`,
            row.family && `Family: ${row.family}.`,
            row.group_type && `Group: ${row.group_type}.`,
          ]
            .filter(Boolean)
            .join(' '),
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'dnp_plant') {
    // The checklist is ~9k rows, so the match is pushed down to Postgres as a
    // trigram ILIKE `or` (dnp_plants_scientific_trgm_idx / _thai_trgm_idx /
    // _english_trgm_idx / _synonyms_trgm_idx, 130/160) rather than fetched whole
    // and filtered here, and the page is bounded. Terms are capped so the url
    // filter cannot grow without limit.
    const columns = ['scientific_name', 'thai_name', 'english_name', 'family', 'genus', 'synonyms'];
    const filters = terms
      .slice(0, 4)
      .flatMap((term) => columns.map((col) => `${col}.ilike.*${encodeURIComponent(term)}*`))
      .join(',');
    const rows = await get<DnpPlantKeywordRow[]>(
      'dnp_plants?select=id,scientific_name,thai_name,family,english_name,genus,synonyms,native_status' +
        ',iucn_status,th_record_count,th_provinces' +
        `&or=(${filters})&limit=${SEARCH_RESULTS * 4}`,
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [row.scientific_name, row.thai_name, row.english_name, row.family, row.genus, row.synonyms]
          .filter(Boolean)
          .join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'dnp_plant',
          entityId: String(row.id),
          title: row.english_name || row.scientific_name || row.thai_name || String(row.id),
          content: [
            row.scientific_name,
            row.thai_name && `(${row.thai_name})`,
            row.english_name && `English: ${row.english_name}.`,
            row.genus && `Genus: ${row.genus}.`,
            row.family && `Family: ${row.family}.`,
            row.native_status && `In Thailand: ${row.native_status}.`,
            row.iucn_status && `IUCN: ${row.iucn_status}.`,
            row.th_record_count != null && `GBIF records in Thailand: ${row.th_record_count}.`,
            row.th_provinces && `Provinces: ${row.th_provinces}.`,
            row.synonyms && `Synonyms: ${row.synonyms}.`,
          ]
            .filter(Boolean)
            .join(' '),
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'dnp_fauna') {
    // The fauna observations are ~5k rows, so the match is pushed down to
    // Postgres as a trigram ILIKE `or` (dnp_fauna_scientific_trgm_idx /
    // _thai_trgm_idx / _area_trgm_idx, the dnp_fauna table) rather than
    // fetched whole and filtered here, and the page is bounded. Terms are
    // capped so the url filter cannot grow without limit.
    const columns = ['scientific_name', 'thai_name', 'protected_area', 'protected_area_en', 'family'];
    const filters = terms
      .slice(0, 4)
      .flatMap((term) => columns.map((col) => `${col}.ilike.*${encodeURIComponent(term)}*`))
      .join(',');
    const rows = await get<DnpFaunaKeywordRow[]>(
      'dnp_fauna?select=id,scientific_name,thai_name,group_type,protected_area,protected_area_en,family,genus,iucn_status' +
        `&or=(${filters})&limit=${SEARCH_RESULTS * 4}`,
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [
          row.scientific_name,
          row.thai_name,
          row.group_type,
          row.protected_area,
          row.protected_area_en,
          row.family,
          row.genus,
        ]
          .filter(Boolean)
          .join(' '),
        terms,
      );
      if (matched.length) {
        hits.push({
          entityType: 'dnp_fauna',
          entityId: String(row.id),
          title: row.scientific_name || row.thai_name || String(row.id),
          content: [
            row.scientific_name,
            row.thai_name && `(${row.thai_name})`,
            `Found in ${row.protected_area}.`,
            row.group_type && `Group: ${row.group_type}.`,
            row.family && `Family: ${row.family}.`,
            row.iucn_status && `IUCN: ${row.iucn_status}.`,
          ]
            .filter(Boolean)
            .join(' '),
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  if (!entityType || entityType === 'dnp_wildlife') {
    // The checklist is ~2k rows, so the match is pushed down to Postgres as a
    // trigram ILIKE `or` (dnp_wildlife_scientific_trgm_idx / _thai_trgm_idx /
    // _english_trgm_idx, the dnp_wildlife table) rather than fetched whole and
    // filtered here, and the page is bounded. Terms are capped so the url
    // filter cannot grow without limit.
    const columns = ['scientific_name', 'thai_name', 'english_name', 'family'];
    const filters = terms
      .slice(0, 4)
      .flatMap((term) => columns.map((col) => `${col}.ilike.*${encodeURIComponent(term)}*`))
      .join(',');
    const rows = await get<DnpWildlifeKeywordRow[]>(
      'dnp_wildlife?select=id,scientific_name,thai_name,english_name,group_type,family,is_reserved,is_protected,iucn_status' +
        `&or=(${filters})&limit=${SEARCH_RESULTS * 4}`,
      caller,
    );
    for (const row of rows) {
      const matched = matchedTerms(
        [row.scientific_name, row.thai_name, row.english_name, row.family, row.group_type]
          .filter(Boolean)
          .join(' '),
        terms,
      );
      if (matched.length) {
        const protection = row.is_reserved
          ? 'Legally reserved wildlife.'
          : row.is_protected
            ? 'Legally protected wildlife.'
            : null;
        hits.push({
          entityType: 'dnp_wildlife',
          entityId: String(row.id),
          title: row.english_name || row.scientific_name || row.thai_name || String(row.id),
          content: [
            row.scientific_name,
            row.thai_name && `(${row.thai_name})`,
            row.english_name && `English: ${row.english_name}.`,
            `Group: ${row.group_type}.`,
            row.family && `Family: ${row.family}.`,
            protection,
            row.iucn_status && `IUCN: ${row.iucn_status}.`,
          ]
            .filter(Boolean)
            .join(' '),
          matchedTerms: matched,
          score: matched.length / terms.length,
        });
      }
    }
  }

  return hits
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, SEARCH_RESULTS);
}

export function registerCatalogTools(server: McpServer, caller: Caller): void {
  server.registerTool(
    'search_forest_knowledge',
    {
      title: 'Search the forest knowledge base',
      description:
        'Search the forest knowledge base: Globie Earth\'s own catalogue of native species, ' +
        'forest sites and guardian lore, together with its broader forest datasets - the ' +
        'protected-area biodiversity survey, the national plant checklist (with English ' +
        'common names, genus, synonyms and native status resolved from GBIF), the ' +
        'national-park fauna observations, and the national wildlife checklist with its ' +
        'statutory protected/reserved status. Use this for any factual question about the ' +
        'forest, its trees, its guardians, what was recorded growing or living in a ' +
        'protected area, which animals are protected by Thai law, or what a species is ' +
        'called. Returns passages ranked by relevance, each with the entity it belongs to. ' +
        'The `ranking` field says how the order was produced: `reranked` when an ' +
        'AI pass reordered the candidates, `cosine` when it is the raw similarity order. ' +
        'When the server has no embedding provider configured it answers with ' +
        'keyword matches over the same text and says so. Read-only.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(500)
          .describe('A natural-language question or keywords, e.g. "which tree fixes paddy soil".'),
        entity_type: z
          .enum([
            'species',
            'site',
            'guardian',
            'dnp_species',
            'dnp_plant',
            'dnp_fauna',
            'dnp_wildlife',
          ])
          .optional()
          .describe(
            'Restrict results to one kind of entry. On top of the species, site and guardian ' +
              'kinds, Globie Earth\'s forest datasets add: `dnp_species`, the biodiversity ' +
              'survey; `dnp_plant`, the national plant checklist; `dnp_fauna`, the ' +
              'national-park fauna observations; and `dnp_wildlife`, the national wildlife ' +
              'checklist. Omit to search all. Set ' +
              'this only when the listener explicitly ' +
              'asked to restrict to that kind: a filter also hides the best answer when it ' +
              'lives in another kind - asked for "Yang na" with `dnp_species` set, the tree ' +
              'named Yang Na in the catalogue is skipped and only butterfly survey rows ' +
              'come back.',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('search_forest_knowledge') } },
    },
    async ({ query, entity_type }) => {
      try {
        const provider = getEmbeddingProvider();

        // A keyword answer, labelled for what it is: a lexical match over the
        // same catalogue text a vector would have been built from, never a
        // cosine similarity that was not computed. Used both when semantic
        // search is switched off and when the configured provider is unusable,
        // so the tool always answers.
        const keywordAnswer = async (reason: string) => {
          const hits = await keywordSearch(query, entity_type, caller);
          const spoken = hits.length
            ? `I found ${hits.length} keyword ${hits.length === 1 ? 'match' : 'matches'} for "${query}". The closest is ${closestLine(hits[0].title, hits[0].content)} These are keyword matches over the catalogue text, not vector similarity.`
            : `I found no match for "${query}" in the forest knowledge. Try a plainer word or a species name.`;
          return jsonResult(
            {
              query,
              entityType: entity_type ?? null,
              method: 'keyword',
              embeddingModel: null,
              note: hits.length
                ? `${reason} These are keyword matches over the catalogue text, not vector similarity.`
                : `${reason} No catalogue entry matched those keywords, so try a plainer word or name.`,
              hits: hits.map((hit) => ({ ...hit })),
            },
            spoken,
            {
              resourceUri: uiUriForTool('search_forest_knowledge'),
              invoking: 'Searching the forest knowledge…',
              invoked: 'Forest knowledge',
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
          // The provider is configured but the call failed - e.g. the account
          // has no Bedrock access. Degrade to the same keyword search rather
          // than leaving the tool dead, naming the reason so nothing is hidden.
          const reason = error instanceof Error ? error.message : 'the embedding provider failed.';
          return keywordAnswer(`Semantic search is unavailable on this server (${reason}).`);
        }

        const rerank = rerankConfig();
        const rows = await rpc<HitRow[]>(
          'catalog_search',
          {
            // PostgREST casts the JSON string to the vector type (see api.ts).
            p_query: `[${vector.join(',')}]`,
            // A wider pool than we answer with when the rerank stage is on, so a
            // passage the small embedding model scored low but that actually
            // answers the question is present for the reranker to promote
            // (infra/mcp plan §16).
            p_match_count: rerank.enabled ? rerank.pool : SEARCH_RESULTS,
            p_entity_type: entity_type ?? null,
            // The raw text, so catalog_search can lift a row whose name actually
            // matches the question (the catalog_search ranking) instead of
            // trusting cosine alone - a small model's cosine floor is high and
            // near-neighbours differ by ~0.01, so an absolute score cannot tell
            // a match from a neighbour.
            p_query_text: query,
          },
          caller,
        );

        // Recipes are not forest knowledge: they live in their own Local Culture
        // tool (search_local_culture). The flat embedding space can still place
        // a dish near a forest question, so drop any recipe row the unfiltered
        // search surfaced rather than answering a forest question with a dish.
        const hits = rows.filter((row) => row.entity_type !== 'recipe');

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
          ? `I found ${top.length} ${top.length === 1 ? 'passage' : 'passages'} for "${query}". The closest is ${closestLine(top[0].title, top[0].content)}`
          : `I found nothing in the forest knowledge for "${query}".`;

        return jsonResult(
          {
            query,
            entityType: entity_type ?? null,
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
            resourceUri: uiUriForTool('search_forest_knowledge'),
            invoking: 'Searching the forest knowledge…',
            invoked: 'Forest knowledge',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    'recommend_species',
    {
      title: 'Recommend species to adopt',
      description:
        'Recommends species that match the caller\'s own taste, learned from the species ' +
        'they have already adopted. Returns nothing when the caller has no adoptions yet ' +
        'or the catalogue has not been embedded. Read-only.',
      inputSchema: {
        match_count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('How many species to return. Defaults to 3.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uiUriForTool('recommend_species') } },
    },
    async ({ match_count }) => {
      try {
        const rows = await rpc<RecommendationRow[]>(
          'recommend_species',
          { p_match_count: match_count ?? 3 },
          caller,
        );

        const spoken = rows.length
          ? `Based on what you have already adopted, I recommend ${rows.map((row) => row.name).join(', ')}. The best match is ${rows[0].name}: ${rows[0].tagline}`
          : 'I have no recommendations yet. They are based on the species you have already adopted, and the catalogue has to be embedded first.';

        return jsonResult(
          {
            recommendations: rows.map((row) => ({
              speciesId: row.species_id,
              name: row.name,
              tagline: row.tagline,
              similarity: row.similarity,
            })),
            // Said plainly, because an empty list here is a real state and not an
            // error: matching needs both adoptions and loaded embeddings.
            note: rows.length
              ? null
              : 'No recommendations yet: this is based on species the caller has already adopted, and the catalogue must be embedded.',
          },
          spoken,
          {
            resourceUri: uiUriForTool('recommend_species'),
            invoking: 'Choosing species for you…',
            invoked: 'Species recommendations',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
