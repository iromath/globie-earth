// Reading the caller's Living Deeds, shared by the tool and the resource.
//
// get_my_deeds and the me/deeds resource are the same read expressed two ways,
// so the query string and the row-to-view mapping live here once. That is the
// point: src/lib/api.ts fetchLivingDeeds() must not be able to drift from what
// the MCP server reports, and neither should two copies of it inside the server.
//
// The read is device-scoped by the RLS policies, not by the query, so the caller's
// own X-Device-Id decides which rows come back.

import type { Caller } from './identity.js';
import { get } from './postgrest.js';

/** One api.living_deeds row with the species embed fetched through the FK. */
export interface DeedRow {
  deed_no: string;
  trees_planted: number;
  stage_index: number;
  stages: string[];
  progress_pct: number;
  co2_offset_kg: number | string;
  issued_at: string;
  adoptions: { species_id: string } | null;
}

/** The exact query src/lib/api.ts fetchLivingDeeds() uses, so the shapes match. */
const DEEDS_QUERY =
  'living_deeds?select=deed_no,trees_planted,stage_index,stages,progress_pct,' +
  'co2_offset_kg,issued_at,adoptions(species_id)&order=issued_at.desc';

/** This device's deeds, newest first. */
export function listDeeds(caller: Caller): Promise<DeedRow[]> {
  return get<DeedRow[]>(DEEDS_QUERY, caller);
}

/** The app-facing shape of one deed, mirrored from src/lib/api.ts DeedRecord. */
export function toDeed(row: DeedRow) {
  return {
    deedNo: row.deed_no,
    speciesId: row.adoptions?.species_id ?? '',
    treesPlanted: row.trees_planted,
    stageIndex: row.stage_index,
    stages: row.stages,
    progressPct: row.progress_pct,
    co2OffsetKg: Number(row.co2_offset_kg),
    issuedAt: row.issued_at,
  };
}
