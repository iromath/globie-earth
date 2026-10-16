# Globie Earth — Alexa+ store listing

The copy for the add-on's store detail page, written to the Alexa+ **Design
Guide: Store Listing**. Everything that maps to a `addon.json` field is mirrored
there — `name`, `shortDescription`, `examplePhrases`, `fullDescription`; the
category and tagline are entered in the Alexa developer console during
onboarding.

## Schema limits

From the Alexa+ MCP QuickStart's `addon.json` schema reference. These are
**hard** field constraints, not editorial advice, and `shortDescription` and
`examplePhrases` were both over them until 2026-10-16: keep them in view when
this copy changes.

| Field | Constraint | Globie Earth |
|---|---|---|
| `name.value` | ≤ 30 characters | 12 |
| `shortDescription` | ≤ 123 characters | 110 |
| `fullDescription` | ≤ 4000 characters | 1049 |
| `examplePhrases` | **3–4 items**, each ≤ 200 characters | 4 |
| `mediaAssets.carouselImages` | ≥ 1 image (600x900), `altText` ≤ 250 chars | 2 |
| `privacyPolicyUrl` / `termsOfUseUrl` | valid HTTPS URLs | both present |

## Category

**Education & Reference** — the primary use case is asking a forest Field Guide
what something is and getting an attributed answer. The Thai cookbook and tree
adoption sit inside that, so a reference category describes the add-on better
than Food & Drink or Lifestyle would. (The console lists the categories you can
pick from; choose only one.)

## Icon

The square app icon — [logo-square-light-120x120.svg](../../public/addon/logo/logo-square-light-120x120.svg)
and its dark counterpart — carries the wordmark only, per the policy that an
icon must not include taglines or promotional text.

## Add-on name

**Globie Earth** — also the invocation name. Twelve characters, two spoken
syllables, no overlap with Alexa system commands.

## Tagline

Only the tagline is visible in the store's browsing views, so it is written as
the action a customer takes rather than as a description of the product.

> **Explore a living forest, then plan the trip**

Eight words, and it carries both halves of the add-on the way the short and full
descriptions now do — the Field Guide first, travel second. Alternatives if a
different emphasis is wanted:

- *Search, cook and adopt in a living forest* (8)
- *Ask a living forest and cook its recipes* (8)
- *A living forest, and where to go next* (8)

## Short description

Visible above the fold on the detail page. Two conversational sentences that
start from what the customer would say.

> **Ask a living forest anything, then plan a trip. Species guide, Thai recipes,
> tree adoption, tours and flights.**

110 characters, inside the 123-character limit for `storeListing.locales["en-US"].shortDescription`.
The opening clause is one sentence, so the travel half lands without a second
full stop eating the budget. This is the string in `addon.json` — if one changes,
change both.

## Sample utterances

Four phrases, covering the three ranges the guide asks for. Every one is written
to be spoken as-is.

| # | Utterance | Range |
|---|---|---|
| 1 | Explore the living forest | Entry-level / open-ended |
| 2 | Search the forest guide for trees that fix paddy soil | Specific, intent-driven |
| 3 | How do I make green curry? | Specific, intent-driven |
| 4 | Find tours in Bangkok | Specific, travel intent |

These four are the `examplePhrases` in `addon.json` (the schema allows 3–4, and
each must be ≤ 200 characters). Slot 4 was `What's my eco balance?` until
2026-10-16; it moved to travel because the add-on now spans the Openmind.Travel
catalogue, and eco balance was the only slot that needed an account to read.

The cookbook and travel pillars each get a slot, and the conditions
path — the one that renders an on-screen card — is named in the short and full
descriptions instead, so the four slots stay spread across capabilities rather
than repeating one.

## Full description

Hook first, then a scannable feature list, then the disclosures the guide
requires (account linking and any device restriction).

---

Explore a living forest in Isan, Thailand - and cook from its kitchen. Ask
Globie Earth which tree fixes paddy soil, what the site is like at the
wetland basin, or how to make green curry, and the answer comes back in a plain
spoken sentence.

You're asking a real Field Guide, not a scraped website. Answers are assembled
from Department of National Parks open data, and every reply says whether it was
measured, modelled or explained.

- Search the Field Guide for the forest's plants and animals
- Check current conditions at the site
- Cook from the project's own Thai cookbook, with ingredients and a numbered
  method read back to you
- Adopt a tree and hear your deeds, eco balance and guardians
- Plan a trip: search tours, flights, destinations and country guides from the
  Openmind.Travel catalogue
- See the answer as an on-screen card, or just listen

Link your Globie Earth account to keep your adopted tree, deeds and eco balance
with you. The visual cards need an Echo Show 8 or larger; every answer still
works by voice alone.

---

`storeListing.locales["en-US"].fullDescription` holds this as a single string
with `\n\n` between blocks. The block above is byte-identical to that string once
whitespace is collapsed — note the plain hyphen in "Thailand -", which follows
the manifest rather than the em dash used in this document's prose — so a copy
change has to be made in both places or the two drift.
