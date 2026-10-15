// The MCP Apps this server ships, and the tool -> app mapping that names them
// (AMAZON-MCP-PLAN.md 20.2 / 20.3 Gap 2 / 21 Phase 5).
//
// SEP-1865 (identifier `io.modelcontextprotocol/ui`) lets a tool name a UI
// resource in `_meta.ui.resourceUri`; a host that understands the extension
// mounts that resource in a sandboxed iframe instead of hydrating the data
// itself. The resource is addressed by `ui://` and its content MUST be a valid
// HTML5 document served as `text/html;profile=mcp-app`.
//
// There are four documents, not fifteen. The Alexa+ design guide names exactly
// four components - Card, List, Carousel, Map - and every tool on this server
// answers in one of those four shapes, so each document is an archetype shared
// by every tool whose result fits it. Which tool a mounted copy is showing is
// read from the host's own `hostContext.toolInfo.tool.name` at runtime, so one
// set of bytes serves all of its tools (ui/card.html and friends).
//
// The documents are real files rather than strings in source, so they stay
// editable as HTML/CSS/JS. Each one's bytes are hashed once at load to mint its
// URI, which makes the resource content-addressed: edit a widget and its URI
// changes with it, so no host ever serves a cached view from the previous
// version. Reading them at load also means a missing bundle fails the boot
// loudly rather than at the first session.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { minioConfig } from '../minio.js';

/**
 * The view media type SEP-1865 requires for a `ui://` resource. The profile
 * parameter is what distinguishes an MCP App from an ordinary HTML resource.
 */
export const UI_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

/** The four documents, one per design-guide component. */
export type UiArchetype = 'card' | 'list' | 'carousel' | 'map';

interface ArchetypeSpec {
  /** The file under ui/, read at load. */
  file: string;
  /** The stem of the resource URI: `ui://globie/<slug>-<digest>`. */
  slug: string;
  /** The human name shown when a host lists its resources. */
  title: string;
  /** What the document draws, in the tools' own vocabulary. */
  description: string;
}

const ARCHETYPES: Record<UiArchetype, ArchetypeSpec> = {
  card: {
    file: 'card.html',
    slug: 'card',
    title: 'Globie Earth — result card',
    description:
      'The single-result card. Draws one species, photo reading, recipe, eco balance, ' +
      'living deed or soundscape: a lead image where there is one, the facts beneath it, ' +
      'and a link out to the source.',
  },
  list: {
    file: 'list.html',
    slug: 'list',
    title: 'Globie Earth — result list',
    description:
      'The collection list. Draws a page of knowledge-base or culture hits, species ' +
      'recommendations, or the listener\'s own living deeds, each with its matched terms ' +
      'or similarity beside it.',
  },
  carousel: {
    file: 'carousel.html',
    slug: 'carousel',
    title: 'Globie Earth — show carousel',
    description:
      'The show carousel. Draws a shelf of podcasts - searched, trending or by theme - ' +
      'as a sideways-scrolling row of covers with each show\'s author, category and ' +
      'episode count.',
  },
  map: {
    file: 'map.html',
    slug: 'map',
    title: 'Globie Earth — sanctuary conditions',
    description:
      'The place view. Draws the sanctuary\'s coordinates on a locator plate beside its ' +
      'modelled air temperature, humidity, European air-quality index and ambient carbon ' +
      'dioxide.',
  },
};

interface UiBundle {
  /** The current URI: `ui://globie/<slug>-<content hash>`. */
  uri: string;
  /** The HTML5 document itself. */
  html: string;
}

/**
 * Reads a widget and mints its content-hashed URI.
 *
 * `../../ui/…` resolves from both this file (src/ui/) and its compiled output
 * (dist/ui/), because each sits one level under the package root; that is
 * deliberately independent of the process's working directory.
 */
function loadBundle(spec: ArchetypeSpec): UiBundle {
  const html = readFileSync(new URL(`../../ui/${spec.file}`, import.meta.url), 'utf8');
  // Twelve hex characters of the SHA-256 is the content address: short enough to
  // read in a URI, wide enough that any edit to the widget is a new URI.
  const digest = createHash('sha256').update(html).digest('hex').slice(0, 12);
  return { uri: `ui://globie/${spec.slug}-${digest}`, html };
}

const BUNDLES: Record<UiArchetype, UiBundle> = {
  card: loadBundle(ARCHETYPES.card),
  list: loadBundle(ARCHETYPES.list),
  carousel: loadBundle(ARCHETYPES.carousel),
  map: loadBundle(ARCHETYPES.map),
};

/** Every tool this server exposes, so a mapping typo cannot compile. */
export type ToolName =
  | 'describe_species'
  | 'describe_photo'
  | 'get_recipe'
  | 'get_eco_balance'
  | 'adopt_species'
  | 'generate_soundscape'
  | 'get_soundscape'
  | 'search_forest_knowledge'
  | 'search_local_culture'
  | 'recommend_species'
  | 'get_my_deeds'
  | 'search_podcasts'
  | 'get_trending_podcasts'
  | 'get_podcasts_by_theme'
  | 'get_sanctuary_conditions';

/**
 * The archetype each tool's successful result belongs to.
 *
 * The keys of each archetype document's own VIEWS table must match these names
 * exactly: the host tells the mounted view which tool it is showing by name, and
 * an unknown name is what makes a view fall back to reading the payload's shape.
 */
const TOOL_ARCHETYPE: Record<ToolName, UiArchetype> = {
  describe_species: 'card',
  describe_photo: 'card',
  get_recipe: 'card',
  get_eco_balance: 'card',
  adopt_species: 'card',
  generate_soundscape: 'card',
  get_soundscape: 'card',
  search_forest_knowledge: 'list',
  search_local_culture: 'list',
  recommend_species: 'list',
  get_my_deeds: 'list',
  search_podcasts: 'carousel',
  get_trending_podcasts: 'carousel',
  get_podcasts_by_theme: 'carousel',
  get_sanctuary_conditions: 'map',
};

/** The URI a tool's `_meta.ui.resourceUri` must name. */
export function uiUriForTool(tool: ToolName): string {
  return BUNDLES[TOOL_ARCHETYPE[tool]].uri;
}

/**
 * The content security policy an archetype's document needs, or undefined when
 * the host's restrictive default already fits.
 *
 * Only the card reaches off-origin: its lead image is either Wikimedia's own
 * thumbnail or the copy this stack caches in object storage. Every other
 * document - list, carousel, map - draws its own covers and makes no network
 * request at all, so `connect-src 'none'` and `img-src 'self' data:` stand.
 *
 * The object-storage origin is read from the environment rather than compiled
 * in, because it is a deployment detail (MINIO_PUBLIC_URL) and changes without
 * the widget changing.
 */
function resourceDomains(archetype: UiArchetype): string[] | undefined {
  if (archetype !== 'card') return undefined;
  const domains = ['https://upload.wikimedia.org'];
  const config = minioConfig();
  if (config) {
    try {
      domains.push(new URL(config.publicUrl).origin);
    } catch {
      // A malformed MINIO_PUBLIC_URL simply earns no entry; the Wikimedia
      // origin still covers the fallback the tool returns.
    }
  }
  return domains;
}

/**
 * The `_meta.ui` an archetype declares, used both on the resources/list entry
 * and on the read content item.
 *
 * `prefersBorder` asks the host to keep our card's own border rather than
 * drawing a second one around it.
 */
function uiMeta(archetype: UiArchetype): {
  prefersBorder: boolean;
  csp?: { resourceDomains: string[] };
} {
  const domains = resourceDomains(archetype);
  return domains ? { prefersBorder: true, csp: { resourceDomains: domains } } : { prefersBorder: true };
}

/**
 * Registers every `ui://` resource so a host can both discover and read them.
 *
 * The metadata is rebuilt per read rather than captured once, so a policy that
 * depends on the environment reflects the environment it is actually serving.
 */
export function registerUiResources(server: McpServer): void {
  for (const name of Object.keys(ARCHETYPES) as UiArchetype[]) {
    const spec = ARCHETYPES[name];
    const bundle = BUNDLES[name];
    server.registerResource(
      `${spec.slug}-ui`,
      bundle.uri,
      {
        title: spec.title,
        description: spec.description,
        mimeType: UI_RESOURCE_MIME_TYPE,
        _meta: { ui: uiMeta(name) },
      },
      async (uri): Promise<ReadResourceResult> => ({
        contents: [
          {
            uri: uri.href,
            mimeType: UI_RESOURCE_MIME_TYPE,
            text: bundle.html,
            // The read content item repeats the metadata; per SEP-1865 it wins
            // over the resources/list entry when both are present.
            _meta: { ui: uiMeta(name) },
          },
        ],
      }),
    );
  }
}
