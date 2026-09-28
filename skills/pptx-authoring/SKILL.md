---
name: pptx-authoring
description: Build or extend an editable PowerPoint deck with python-pptx — layouts from the master, one idea per slide, native charts, speaker notes — and prove every slide renders without overflowing its text boxes. Use when the deliverable is a .pptx, a pitch deck, a slide deck, a board pack or a presentation the owner will edit. Do not use to make an HTML or PDF-only presentation, and never export slides as images into a .pptx.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by garden - python-pptx through /usr/local/lib/garden/python/bin/python3, garden-office-convert, and poppler-utils.
allowed-tools: shell file_read file_write files_list document_read image_read publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.2.0'
  garden.risk: 'workspace'
  garden.domain: 'presentations'
---

# Presentation authoring

Run every script in this skill with `/usr/local/lib/garden/python/bin/python3`. It is the one
interpreter this computer probes for, the release drill refuses to ship without, and every skill
here names — a superset of the distribution's own packages, so a procedure written against it keeps
working when a library moves to the pinned set. Do not reach for a bare `python3`.

## Decide the deck before writing the file

Write the storyline as a numbered list first and confirm it with the owner if the deck is for an
audience you cannot see. For each slide: the single claim it makes, the evidence on it, and the
transition to the next. If a slide has two claims it is two slides; if it has none it is a section
divider or it is cut. Ten to fifteen content slides is a talk; forty is a document that should have
been a report.

Then write the file.

## Building with python-pptx

Write `workspace/build_deck.py` and re-run it after every correction. Never build a deck through a
chain of one-liners; you will need to rebuild it three times.

```python
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.text import MSO_AUTO_SIZE

prs = Presentation()                                     # or Presentation('brand.potx')
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)   # 16:9
```

**The size trap that costs a whole deck.** python-pptx's built-in template is 10 × 7.5 inches and
its layout placeholders are 9 inches wide. Widening the slide to 16:9 does not widen them, so a
deck that only sets `slide_width` lays every bullet out in the left three quarters of the slide and
leaves a bar of dead space down the right. Setting the size _before_ adding slides does not help
either — the placeholder geometry lives in the layout, not the slide. So:

- **Starting from nothing**: set 16:9, then place the title and body on every slide from the
  slide's own dimensions.
- **Starting from the owner's `.potx`**: use the size it already has and never change it. Its
  placeholders are positioned for that size.

```python
margin, body_top = Inches(0.6), Inches(1.75)
text_width = prs.slide_width - 2 * margin
body_height = prs.slide_height - body_top - Inches(0.6)

slide = prs.slides.add_slide(prs.slide_layouts[1])       # Title and Content
title = slide.shapes.title
title.left, title.top, title.width, title.height = margin, Inches(0.45), text_width, Inches(1.1)
title.text = 'Where the quarter landed'

body = slide.placeholders[1]
body.left, body.top, body.width, body.height = margin, body_top, text_width, body_height
tf = body.text_frame
tf.word_wrap = True
tf.auto_size = MSO_AUTO_SIZE.NONE
tf.text = 'First point'
p = tf.add_paragraph(); p.text = 'Second point'; p.level = 1
for paragraph in tf.paragraphs:
    for run in paragraph.runs:
        run.font.size = Pt(18)
```

- **Always use a layout from the master**: `prs.slide_layouts[i]`. Print
  `[(i, l.name) for i, l in enumerate(prs.slide_layouts)]` once and pick by name. Free-floating
  text boxes on a blank layout produce a deck that ignores the theme and cannot be restyled.
- **Fill placeholders, do not create boxes.** A placeholder inherits font and colour from the
  master; only its geometry is being overridden above.
- **Set the font size explicitly on every run.** It is the only way the fit check below has a
  number to work with, and it is what stops a template's 32pt body from silently eating a slide.
- **Budget the text.** At 18pt in a 12.1 × 5.15 inch body, a slide holds about 17 lines of roughly
  95 characters. Count before you write; this is the most common defect in generated decks.
- **Native charts, not images**:
  ```python
  from pptx.chart.data import CategoryChartData
  from pptx.enum.chart import XL_CHART_TYPE
  data = CategoryChartData(); data.categories = ['Q1','Q2']; data.add_series('Revenue', (1.2, 1.9))
  slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, margin, body_top, text_width,
                         body_height, data)
  ```
  A native chart stays editable and keeps the theme colours. A pasted PNG does not.
- **Tables**: `slide.shapes.add_table(rows, cols, left, top, width, height).table`. Five columns
  and eight rows is the ceiling; beyond that it belongs in an appendix or a spreadsheet.
- **Speaker notes**: `slide.notes_slide.notes_text_frame.text = '...'`. Write them on every slide;
  they are what makes a deck usable by the person presenting it.
- **Images**: `slide.shapes.add_picture(path, left, top, width=...)`. Set width only and let the
  height follow, or the aspect ratio distorts.

## Check the text fits before rendering

PowerPoint text boxes do not grow. Excess text is clipped at render with no error. Check capacity
in the build script, before you spend a conversion on it:

```python
import math
EMU_PER_POINT = 12700
def overflows(shape, size_points):
    width_points = shape.width / EMU_PER_POINT
    per_line = max(1, int(width_points / (size_points * 0.5)))    # ~0.5 em average advance
    needed = sum(max(1, math.ceil(len(p.text) / per_line))
                 for p in shape.text_frame.paragraphs if p.text)
    available = max(1, int((shape.height / EMU_PER_POINT) / (size_points * 1.2)))
    return needed > available
```

Cut or split the slide when this returns true. Never fix it by shrinking the font below 16pt — a
slide nobody can read from the back of a room is not a fixed slide. This estimate is the cheap
gate; the round-trip word count in the verification below is the authority.

## Editing an existing deck

Open it, enumerate what is there, then change only what was asked:

```python
for i, s in enumerate(prs.slides):
    print(i, s.slide_layout.name, [sh.shape_type for sh in s.shapes])
```

python-pptx cannot delete a slide through the public API. Drop it through the XML:

```python
xml_slides = prs.slides._sldIdLst
xml_slides.remove(list(xml_slides)[index])
```

Reordering works the same way — move the `sldId` element. Never rebuild an owner's deck from
scratch to change three slides; the master, theme and custom layouts will not survive.

## Verification

1. Reopen with python-pptx: slide count, and the placeholder text of every slide. Confirm nothing
   is empty that should not be, and that every slide has notes.
2. `garden-office-convert deck.pptx proofs/deck.pdf`, then `pdftoppm -jpeg -r 120 proofs/deck.pdf
proofs/p`.
3. The slide count is `expectPages` on the acceptance render clause, declared before the deck was
   built rather than counted afterwards.
4. `pdftotext -layout proofs/deck.pdf proofs/deck.txt` and compare its word count against the sum
   of the text you placed. A deficit above 2% means a text box clipped its content. Nothing else
   catches this.
5. `image_read` every slide image. Check: nothing overlapping, chart axes labelled, the same title
   position on every slide, no slide that is only a title. Text at the slide edge belongs to the
   render clause, which tolerates it on purpose: a full-bleed slide is meant to reach the edge.
6. Publish with `publish_artifact` and attach the slide images.

## Failure modes

- **A 16:9 deck on 4:3 placeholders.** The commonest defect, and it looks like nothing is wrong
  until the owner opens it. Reposition, as above.
- **Text clipped, not overflowing.** No error, no warning, the file opens fine. Only the round-trip
  word count catches it.
- **Marp or reveal.js exported to .pptx.** The export is one image per slide. The owner opens it to
  fix a typo and finds a picture. Do not use those tools here.
- **A deck built on the blank layout.** It looks acceptable in the proof and wrong on the owner's
  screen, because it inherits nothing.
- **Fonts.** A theme font that is not on this machine renders as a substitute and every line wraps
  differently than it will for the owner. `fc-list | grep -i <family>` before trusting a theme.
