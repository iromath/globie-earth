// The sanctuary conditions tool: live readings for the wetland's coordinates.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describeAqi, fetchSanctuaryConditions, SANCTUARY_COORDINATE } from '../conditions.js';
import { uiUriForTool } from '../ui/apps.js';
import { errorResult, jsonResult } from './result.js';

export function registerConditionsTools(server: McpServer): void {
  server.registerTool(
    'get_sanctuary_conditions',
    {
      title: 'Get sanctuary conditions',
      description:
        'Current conditions at the Globie Earth sanctuary: ambient carbon dioxide, ' +
        'European air quality index, relative humidity and air temperature. These are ' +
        'Open-Meteo *modelled* fields for the sanctuary coordinates, not readings from a ' +
        'sensor on site - say so if you report them. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      // SEP-1865: name the MCP App that renders this tool. A host without the
      // extension ignores it and falls back to the JSON text block.
      _meta: { ui: { resourceUri: uiUriForTool('get_sanctuary_conditions') } },
    },
    async () => {
      try {
        const conditions = await fetchSanctuaryConditions();
        if (!conditions) {
          return errorResult(
            'The sanctuary\'s live conditions could not be read from Open-Meteo just now. ' +
              'Nothing is wrong with the adoption data; try again shortly.',
          );
        }

        const aqiLabel = conditions.europeanAqi === null ? null : describeAqi(conditions.europeanAqi);

        // Built from whichever readings came back, so a missing field is left
        // out rather than read aloud as a null.
        const readings: string[] = [];
        if (conditions.temperatureC !== null) readings.push(`it is ${conditions.temperatureC} degrees Celsius`);
        if (conditions.humidityPct !== null) readings.push(`humidity is ${conditions.humidityPct} percent`);
        if (conditions.europeanAqi !== null) {
          readings.push(`air quality is ${aqiLabel ?? 'unbanded'} at ${conditions.europeanAqi} on the European index`);
        }
        if (conditions.carbonDioxidePpm !== null) {
          readings.push(`atmospheric carbon dioxide is ${conditions.carbonDioxidePpm} parts per million`);
        }
        const spoken = readings.length
          ? `At the sanctuary right now, ${readings.join(', ')}. These are Open-Meteo modelled fields, not readings from an on-site sensor.`
          : 'The sanctuary conditions came back without any readings just now.';

        return jsonResult(
          {
            ...conditions,
            // Only when there is a number to band, so a missing AQI does not read
            // as a made-up "Good".
            aqiLabel,
            coordinate: SANCTUARY_COORDINATE,
            source: 'Open-Meteo modelled fields (not an on-site sensor)',
          },
          spoken,
          {
            resourceUri: uiUriForTool('get_sanctuary_conditions'),
            invoking: 'Reading sanctuary conditions…',
            invoked: 'Sanctuary conditions',
          },
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
