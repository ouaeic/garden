---
name: media-creation
description: Produce images, speech, diagrams and video edits — pictures and voiceovers generated through the owner's configured provider, everything else edited deterministically with ffmpeg, ImageMagick and Graphviz — and inspect the result before delivering it. Use when the deliverable is a picture, an illustration, a diagram, an audio clip, a voiceover, a video edit or a screen recording. Do not use to run any model locally, do not use to generate a video from a prompt because there is no route to one, and do not use for charts derived from data, which belong to data-analysis.
license: AGPL-3.0-or-later
compatibility: Every deterministic tool named here is installed on this computer by garden - ffmpeg, ImageMagick as `magick`, and Graphviz. Generated images and speech go through the owner's configured provider; there is no generated video here at all.
allowed-tools: generate_media image_read audio_read shell file_read file_write files_list publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.2.0'
  garden.risk: 'workspace'
  garden.domain: 'media'
---

# Media creation

Two paths, chosen deliberately: generation is probabilistic and costs the owner money;
transformation is deterministic and free. If the task is crop, resize, convert, trim, transcode,
concatenate, subtitle, composite, or draw a diagram from a specification, nothing is generated —
and ffmpeg, ImageMagick and Graphviz are all installed here, so you already know how. What follows
is only what this computer does differently.

## ImageMagick is `magick`, and it cannot open a PDF

`magick` is the one spelling guaranteed to exist. The installer shims it where the distribution
package provides only ImageMagick 6's `convert`, precisely so nothing downstream has to branch on
which version landed.

That same distribution ships a policy file disabling ImageMagick's PDF coder, so `magick in.pdf`
returns a security-policy error rather than an image. To rasterise a PDF page use
`pdftoppm -png -r 200 -f 1 -l 1 in.pdf page`.

`-strip` anything before it leaves the workspace. Camera images carry GPS and device metadata, and
unstripped EXIF has published home addresses.

## There is no generated video, at all

The provider has no zero-retention route to it, so `generate_media` refuses video outright and no
model weights run on this machine. A request for a generated clip is answered by saying that at the
point it is asked for — not after a failed call — and offering what can actually be done: stills, a
Graphviz diagram, or an ffmpeg edit of footage the owner already has.

Diagrams are drawn, never generated. A generated "architecture diagram" has invented boxes and
misspelled labels; `dot` produces the same picture from a source file that survives editing.

## What a generation costs before it is refused

`generate_media` prices the request and checks it against the owner's spending limit before the
provider is called. On top of that, **once a single task has spent about $0.25 on media, every
further generation stops for the owner's approval.** So say what a batch will cost before starting
it, iterate on the prompt rather than the seed, and set a hard limit — three attempts, then show
what you have and ask. Each re-roll is their money.

## Listening back

`image_read` every generated image against the brief, always: generation returns success for a
picture that is nothing like it.

Speech has the equivalent and it is skipped more often. `audio_read` the generated `.mp3` and
compare the transcript to the script word for word. It is the only way to catch a mispronounced
name, a dropped clause, or a number read as digits, and a clip nobody listened to is not a
delivered clip.
