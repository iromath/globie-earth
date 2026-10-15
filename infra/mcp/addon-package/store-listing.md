# Globie Earth — Alexa+ store listing

The copy for the add-on's store detail page, written to the Alexa+ **Design
Guide: Store Listing**. Everything that maps to a `addon.json` field is mirrored
there — `name`, `shortDescription`, `examplePhrases`, `fullDescription`; the
category and tagline are entered in the Alexa developer console during
onboarding.

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

> **Explore a living forest and cook Thai food**

Eight words. Alternatives if a different emphasis is wanted:

- *Search, cook and adopt in a living forest* (8)
- *Ask a living forest and cook its recipes* (8)

## Short description

Visible above the fold on the detail page. Two conversational sentences that
start from what the customer would say.

> **Ask a living forest anything. Search its species guide, check sanctuary
> conditions, cook Thai recipes, or adopt a tree.**

119 characters, inside the 123-character limit for `storeListing.locales["en-US"].shortDescription`.

## Sample utterances

Four phrases, covering the three ranges the guide asks for. Every one is written
to be spoken as-is.

| # | Utterance | Range |
|---|---|---|
| 1 | Explore the forest sanctuary | Entry-level / open-ended |
| 2 | Search the forest guide for trees that fix paddy soil | Specific, intent-driven |
| 3 | How do I make green curry? | Specific, intent-driven |
| 4 | What's my eco balance? | Follow-up / status |

The cookbook pillar is deliberately covered here, and the sanctuary-conditions
path — the one that renders an on-screen card — is named in the short and full
descriptions instead, so the four slots stay spread across capabilities rather
than repeating one.

## Full description

Hook first, then a scannable feature list, then the disclosures the guide
requires (account linking and any device restriction).

---

Explore a living forest in Isan, Thailand — and cook from its kitchen. Ask
Globie Earth which tree fixes paddy soil, what the sanctuary is like at the
wetland basin, or how to make green curry, and the answer comes back in a plain
spoken sentence.

You're asking a real Field Guide, not a scraped website. Answers are assembled
from Department of National Parks open data, and every reply says whether it was
measured, modelled or explained.

- Search the Field Guide for the forest's plants and animals
- Check current conditions at the sanctuary
- Cook from the project's own Thai cookbook, with ingredients and a numbered
  method read back to you
- Adopt a tree and hear your deeds, eco balance and guardians
- See the answer as an on-screen card, or just listen

Link your Globie Earth account to keep your adopted tree, deeds and eco balance
with you. The visual cards need an Echo Show 8 or larger; every answer still
works by voice alone.

---

`storeListing.locales["en-US"].fullDescription` holds this as a single string
with `\n\n` between blocks.
