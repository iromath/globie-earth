// Publishing a soundscape into the public Globie Earth sound library.
//
// The library a listener owns is private (GET /v1/studio/library, scoped to the
// caller's device by RLS); the public catalogue is a different read
// (GET /v1/studio/public). Making one track cross over is a PATCH on the same
// device-scoped row, so the X-Device-Id callProxy already sends is the whole
// authorization. Shared by tools/studio.ts and the Alexa adapter, which reaches
// the same row from a voice turn without going through a tool.

import type { Caller } from './identity.js';
import { callProxy } from './proxy.js';

export type TrackStatus = 'queued' | 'generating' | 'ready' | 'failed';
export type TrackVisibility = 'private' | 'public';

/** One row of GET /v1/studio/library - the caller's own tracks, newest first. */
export interface LibraryTrack {
  id: string;
  status: TrackStatus;
  title: string;
  /** Relative to the studio origin, and only set once the render is ready. */
  audioUrl: string | null;
}

/** The owner DTO PATCH /v1/studio/tracks/:id answers with. */
export interface OwnerTrack extends LibraryTrack {
  visibility: TrackVisibility;
  publishedAt: string | null;
}

/** The caller's own soundscapes, newest first. */
export async function libraryTracks(caller: Caller): Promise<LibraryTrack[]> {
  const { tracks } = await callProxy<{ tracks?: LibraryTrack[] }>(
    'studio',
    '/v1/studio/library',
    caller,
  );
  return tracks ?? [];
}

/** The newest track that has finished rendering, or null when none has. */
export function newestReady(tracks: LibraryTrack[]): LibraryTrack | null {
  return tracks.find((track) => track.status === 'ready' && track.audioUrl) ?? null;
}

/**
 * Publishes or unpublishes one of the caller's ready tracks.
 *
 * The proxy answers 404 for a track this device does not own, 409 while the
 * render is unfinished, 422 when the publish filter rejects the title or style,
 * and 429 once the per-device published cap is reached.
 */
export async function setTrackVisibility(
  caller: Caller,
  trackId: string,
  visibility: TrackVisibility,
): Promise<OwnerTrack> {
  return callProxy<OwnerTrack>(
    'studio',
    `/v1/studio/tracks/${encodeURIComponent(trackId)}`,
    caller,
    { method: 'PATCH', body: { visibility } },
  );
}
