---
name: citation-discipline
description: Attach a resolvable source and a verbatim quoted span to every factual claim, then re-fetch each source before delivery and confirm the quote still supports the claim. Use whenever research, a briefing, a vendor or market comparison, or any answer the owner might act on carries facts, numbers, dates or attributed statements. Do not use for the owner's own data, for arithmetic derived in the answer itself, or for clearly labelled opinion.
license: AGPL-3.0-or-later
compatibility: Requires the garden browser runner for re-fetching; no other binaries.
allowed-tools: parallel_web_read web_search browser_snapshot browser_action document_read document_search file_write
metadata:
  garden.tier: 'builtin'
  garden.version: '1.1.0'
  garden.risk: 'read_only'
  garden.domain: 'research'
---

# Citation discipline

Judging a source and preferring the primary artifact over the outlet that summarised it are things
you already do. Two things here are not: the guards that have to be set before you read anything,
and the pass at the end that is skipped because it happens after the interesting work is over.

## Two guards, set before the first search

Both are cheap now and impossible later, because once you are in the material you will not set them
honestly.

- **Name the disconfirming evidence** — what would change the conclusion — before the first search.
  Without it, searching becomes a hunt for support: the conclusion forms in the first few pages and
  every later source is read for whether it agrees. The acceptance check on this skill asks what you
  looked for and what turned up.
- **When comparing options, write the criteria and their weights down** before any score is filled
  in. Criteria chosen once the winner is known produce a table that looks like analysis and is a
  rationalisation.

## What a claim has to carry to survive that pass

A resolvable source with the date it was fetched, a verbatim span of at most twenty-five words that
entails the claim **on its own** — "revenue grew" does not support "revenue grew 18%" — and a
locator: page number for a PDF, section heading or anchor for a page, timestamp for a video, row
identifier for a dataset. Anything without a locatable span is not supported; weaken it or drop it.

**False precision** is the other half of that unit: "roughly 20–30%, from two vendor estimates" is
more useful and more honest than "24%", because a number carried forward without its uncertainty is
read as measured.

## The pass before delivery

Mandatory, and it is where the errors actually are. For every citation:

1. **Re-fetch now** — `parallel_web_read` for the public URLs, `document_read` for local files. A
   link that resolved during research may 404, redirect to a generic page, or have been edited under
   the same URL.
2. **Locate the quote verbatim** in the freshly fetched text. Normalise typographic quotes,
   ligatures and hyphenation before matching: a failed match is usually a formatting artefact rather
   than a missing quote, and you have to establish which.
3. **Re-read the claim against the quote** and ask whether that span alone establishes it. Claims
   get edited during writing while the citation stays attached to the older, narrower statement, so
   check the pair rather than the link.
4. **Check the fetch did not land on a login wall, a cookie interstitial or a paywall.** Those
   return 200 with plausible text and none of the content.
5. Record the outcome per citation — `ok`, `moved` (new URL), `changed` (the quote is no longer
   there), `dead` — and report everything that is not `ok`. For a `dead` link, one `web_search` on
   the title or a distinctive phrase from the quote usually finds where the page went; confirm the
   relocated page still carries the quote before repointing the citation at it.

## Four states, said out loud

A claim you cannot source is labelled, never silently deleted and never silently kept: deleting it
loses information, keeping it launders a guess into a fact.

- **verified** — source and quote checked in the pass above.
- **reported** — a source says it, attributed, not independently confirmed.
- **inferred** — derived by you from verified facts, with the derivation shown.
- **unverified** — believed, no primary source located. Say so in the line itself:
  `[unverified] The migration is believed to have completed in Q1; no primary source located.`

A contradiction between two sources is recorded the moment you see it, and the answer says which one
you relied on and why. It is the most damaging thing a researched answer can contain, because
nothing in it looks wrong.
