-- Globie Earth :: 231 :: organ-labelled, multi-photo contributions
--
-- 220 let one photograph be offered and one scan verdict be recorded. A single
-- unlabelled photo is thin evidence: one spiny leaf reads as a thistle just as
-- easily as it reads as Acanthus, and a visitor's correct photograph of
-- เหงือกปลาหมอ was turned away as Argemone mexicana for exactly that reason.
--
-- The route now asks for the parts that identify a plant or an animal - the
-- whole habit, a leaf, a flower, a fruit, a head, the markings - labels each
-- photo with the organ it shows, and lets the model answer "unsure, show me
-- more" instead of forcing a yes/no. This migration is where that richer
-- submission is kept.
--
-- Additive only. photo_key / photo_url stay the primary (hero) image, so the
-- moderation queue and the species page read exactly as they did before; the
-- full set lives beside them in `photos`.

alter table api.species_contributions
  -- The organ of each submitted photo, in submission order, e.g. {whole,leaf,flower}.
  add column if not exists organs text[],
  -- Every submitted photo as [{key,url,organ,contentType,byteSize}]. photo_key /
  -- photo_url above remain the primary (first) image, so existing readers do not
  -- change and the extra parts are available to a moderator.
  add column if not exists photos jsonb,
  -- The scan's identity verdict. `match` was confirmed against the named
  -- species; `unsure` is a safe, plausible photo that the model could not
  -- confirm, kept so a steward can; `mismatch` is a clear contradiction and is
  -- refused at the route, so it never reaches this table.
  add column if not exists ai_verdict text
    check (ai_verdict in ('match','unsure','mismatch')),
  -- The scan's self-reported confidence in that verdict, 0..1.
  add column if not exists ai_confidence numeric(3,2)
    check (ai_confidence is null or (ai_confidence >= 0 and ai_confidence <= 1));

comment on column api.species_contributions.organs is
  'Organ role of each submitted photo, in submission order (whole, leaf, flower, fruit, bark, head, body, habitat, other).';
comment on column api.species_contributions.photos is
  'Every submitted photo as [{key,url,organ,contentType,byteSize}]; photo_key/photo_url stay the primary (first) image.';
comment on column api.species_contributions.ai_verdict is
  'Scan identity verdict: match (confirmed), unsure (kept for a steward), or mismatch (refused, never stored).';
comment on column api.species_contributions.ai_confidence is
  'The scan''s confidence in ai_verdict, 0..1, or NULL when the model did not give one.';

-- A new column on an existing table is invisible to PostgREST until it is told
-- to re-read the schema (same reason 230 notifies for api.moderators).
notify pgrst, 'reload schema';
