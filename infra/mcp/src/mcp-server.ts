// The MCP surface itself: one server, built per caller.
//
// This lives apart from server.ts for one reason. server.ts is the bootstrap -
// it registers the side-routes, opens the port and exits the process on a
// missing POSTGREST_URL. The Alexa Skill adapter (alexa.ts) has to reach this
// exact tool surface in-process, and importing server.ts to get at it would
// run all of that as an import side effect. So the surface is here, and it
// touches nothing but the SDK and the tools themselves: a resolved caller in,
// a server whose tools are closed over that caller out.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Caller } from './identity.js';
import { registerForestPrompts } from './prompts/forest.js';
import { registerCatalogResources } from './resources/catalog.js';
import { registerDeedResources } from './resources/deeds.js';
import { registerAdoptionTools } from './tools/adoption.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerConditionsTools } from './tools/conditions.js';
import { registerCookbookTools } from './tools/cookbook.js';
import { registerPodcastTools } from './tools/podcast.js';
import { registerPhotoTools } from './tools/photo.js';
import { registerStudioTools } from './tools/studio.js';
import { registerWebTools } from './tools/web.js';
import { registerWikiTools } from './tools/wiki.js';
import { registerUiResources } from './ui/apps.js';
import { registerOpenmindCommunityTools } from './tools/openmind-community.js';
import { registerOpenmindDestinationsTools } from './tools/openmind-destinations.js';
import { registerOpenmindFlightsTools } from './tools/openmind-flights.js';
import { registerOpenmindGuidesTools } from './tools/openmind-guides.js';
import { registerOpenmindImpactTools } from './tools/openmind-impact.js';
import { registerOpenmindToursTools } from './tools/openmind-tours.js';
import { registerOpenmindTripsTools } from './tools/openmind-trips.js';

/** A server with the caller's identity closed over its tools. */
export function buildServer(caller: Caller): McpServer {
  const server = new McpServer(
    { name: 'globie-earth', version: '1.0.0' },
    {
      instructions:
        'Globie Earth is a regenerative agroforestry site in Isaan, Thailand. Use these tools ' +
        'to answer questions about its native species, sites and guardian lore, to ' +
        'recommend a species the listener might adopt, to report live site ' +
        'conditions, to find podcasts about the living world, and to explore local ' +
        'culture through the site\'s own Thai cookbook (search_local_culture, then ' +
        'get_recipe for the full ingredients and method). A listener may also attach a ' +
        'photo: describe_photo reads any photo, not only trees. describe_species reads the ' +
        'English Wikipedia lead for one species ' +
        'by name - that is external reference text under CC BY-SA, so name Wikipedia as the ' +
        'source and never present it as Globie data. For anything outside the site\'s own ' +
        'records - current news, another place or organisation, an event - use search_web; ' +
        'that is live web content via Tavily, external and possibly unverified, so name the ' +
        'open web as the source and never present it as Globie data. Adoption and soundscape ' +
        'tools are mutating and must be confirmed by the listener first; a soundscape is ' +
        'queued, not produced, so never say one is ready. When you report site ' +
        'conditions, say that they are modelled fields rather than on-site sensor readings.',
    },
  );

  registerCatalogTools(server, caller);
  registerCookbookTools(server, caller);
  registerConditionsTools(server);
  registerWikiTools(server);
  registerWebTools(server);
  registerPhotoTools(server);
  registerAdoptionTools(server, caller);
  registerStudioTools(server, caller);
  registerPodcastTools(server, caller);

  // Openmind.Travel tools: the same travel catalogue (tours, guides, flights,
  // community, trip planning, impact) the web app exposes via browser-side
  // WebMCP, re-served here as MCP tools over the public REST API.
  registerOpenmindToursTools(server);
  registerOpenmindGuidesTools(server);
  registerOpenmindDestinationsTools(server);
  registerOpenmindFlightsTools(server);
  registerOpenmindCommunityTools(server);
  registerOpenmindTripsTools(server);
  registerOpenmindImpactTools(server);

  registerCatalogResources(server, caller);
  registerDeedResources(server, caller);
  registerUiResources(server);

  registerForestPrompts(server);

  return server;
}
