// The Globie listening themes.
//
// A theme is not a mirror category. The index's categories are its publishers'
// own words - news, science, society & culture - and it carries no `meditation`,
// `mindfulness`, `sustainability` or `climate` token at all. Verified against the
// live /categories response, whose biggest tokens are religion, christianity and
// spirituality. So each theme is a full-text search over the same local FTS5
// index browse and search use, which is why the results are shows *matching* a
// theme, never a "category".
//
// This list is the single source of truth for the whole stack: the proxy serves
// it on /v1/podcast/themes, the app's Listen shelf draws its chips from it, and
// the MCP tool reads it. Adding a theme here is the only change needed to add one
// everywhere. The labels are the brief's own words.

import { searchFeeds, toMatchExpression, type FeedRow } from './mirror.js';

/** One theme: a stable slug for the wire, and the words a listener reads. */
export interface PodcastTheme {
  theme: string;
  label: string;
}

const THEMES: PodcastTheme[] = [
  { theme: 'meditation', label: 'Meditation' },
  { theme: 'mindfulness', label: 'Mindfulness' },
  { theme: 'nature', label: 'Nature' },
  { theme: 'sustainability', label: 'Sustainability' },
  { theme: 'climate', label: 'Climate' },
  { theme: 'science', label: 'Science' },
  { theme: 'motivational', label: 'Motivational' },
  { theme: 'personal-development', label: 'Personal Development' },
  { theme: 'forest', label: 'Forest' },
  { theme: 'wellbeing', label: 'Wellbeing' },
];

/** Every theme, in the order they are shown. */
export function listThemes(): PodcastTheme[] {
  return THEMES;
}

/** The fold both the seed list and an incoming name go through. */
function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The theme a caller named, by slug or by label ("forest" or
 * "Forest"), or null. Folding both through the same slug is what makes
 * the label an acceptable spelling rather than a second list to keep in step.
 */
export function findTheme(name: string): PodcastTheme | null {
  const slug = slugify(name);
  if (!slug) return null;
  return THEMES.find((theme) => theme.theme === slug) ?? null;
}

/**
 * The shows for one theme: a full-text search for the theme's own words over the
 * local index. The blocked-category and blocked-text exclusions inside
 * `searchFeeds` apply here exactly as they do for browse and search, so a theme
 * can never surface a feed the rest of the shelf hides.
 */
export function listByTheme(theme: PodcastTheme, limit: number): FeedRow[] {
  const expression = toMatchExpression(theme.label);
  // A label of nothing but punctuation would leave no usable tokens; the list
  // above has none, but the guard keeps a bad edit from reaching the MATCH.
  if (!expression) return [];
  return searchFeeds(expression, limit);
}
