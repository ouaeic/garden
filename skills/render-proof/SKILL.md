---
name: render-proof
description: Prove that a generated .docx, .pptx, .xlsx or PDF actually looks right: declare the render acceptance check the harness measures for itself, validate the file's structure, render every page to an image, scan for placeholder text, missing fonts and content that never arrived, then look at the pages for the faults no measurement catches. Use before building any visual deliverable and again before showing it to the owner. Do not use for plain text, Markdown, JSON or source code, which have no rendered form.
license: AGPL-3.0-or-later
compatibility: Every tool named here is installed on this computer by garden - garden-office-convert, typst, poppler-utils, qpdf, and the interpreter at /usr/local/lib/garden/python/bin/python3.
allowed-tools: shell file_read files_list document_read image_read set_acceptance publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.3.0'
  garden.risk: 'workspace'
  garden.domain: 'output-quality'
---

# Render proof

A file that was written without an error is not a file that is correct. Text-box overflow,
truncated table columns, blank pages, substituted fonts and `#REF!` cells all produce structurally
valid documents. This is the one pipeline that catches them, and every visual deliverable goes
through it before the owner sees it.

Two names are used throughout and there is no alternative to either:

- **`garden-office-convert IN OUT`** converts a Word, PowerPoint or Excel file. The target format
  comes from the output extension. It exits non-zero when the bytes are not there, which bare
  LibreOffice does not.
- **`/usr/local/lib/garden/python/bin/python3`** is the Python that has python-pptx, python-docx,
  openpyxl, pandas, matplotlib, Pillow and pypdf. Plain `python3` does not have pypdf. Write the
  path out in full every time.

Work in `workspace/proofs/<artifact-stem>/`. Delete that directory at the start of every run, or
you will grade last run's pages. Keep the images; they are attached to the reply.

## Stage 0 — declare the reading that is not yours

Before you build the document, `set_acceptance` with an `artifact` check on the deliverable path
carrying a `render` clause. At `finish` the harness renders that file itself — the deliverable as
it stands on disk at that moment, not a proof PDF from earlier in the turn — and refuses the finish
while what it finds is wrong. Every other stage here is you grading your own output. This is the
one reading of it that is not.

It reports the page count, every word the render had to cut at an edge, and every page that has no
text and no ink on it. Nothing else: it never reads the words, so nothing below is covered by it.

Two fields, both optional, and both to be left out unless the job asked for them. `expectPages` is
the exact number of pages — a count nobody specified is not a defect, and declaring one invents a
failure. `marginPoints` moves the boundary inward for a job that was given a margin; without it the
boundary is the page edge itself, which is what you want, because a full-bleed slide with a word
deliberately touching the edge is correct work. `render: {}` with neither is still worth declaring:
it renders, nothing on it was cut, no page of it is blank.

What it cannot see is text pushed _entirely_ past an edge — poppler keeps a glyph only when the pen
that drew it was on the page — and that is what check 1 of stage 3 is for.

## Stage 1 — structural validation

| Artifact          | Command                                                                                                                                                                | Failure                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| PDF               | `qpdf --check out.pdf`                                                                                                                                                 | any error line, or exit 2      |
| .docx/.pptx/.xlsx | `/usr/local/lib/garden/python/bin/python3 -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), '[Content_Types].xml' in z.namelist())" out.docx` | non-`None` testzip, or `False` |
| .xlsx             | reopen with `openpyxl.load_workbook(path)` and with `load_workbook(path, data_only=True)`                                                                              | either raises                  |
| Typst source      | `typst compile in.typ out.pdf`                                                                                                                                         | non-zero exit, or any warning  |

A convergence warning from Typst means the layout never stabilised. Treat it as a failure, not a
warning: the page you get is not the page the source describes.

## Stage 2 — render to images

Everything goes down one path: to a PDF first, then to JPEGs.

```
garden-office-convert out.docx proofs/out.pdf     # .docx, .pptx and .xlsx all go this way
typst compile report.typ proofs/out.pdf            # Typst source
pdftoppm -jpeg -r 120 proofs/out.pdf proofs/p
```

`pdftoppm` writes `p-01.jpg`, `p-02.jpg`, … Render at 120 dpi: high enough to read 8pt type, low
enough that a 40-page document stays inspectable.

Do not author through HTML. `print_pdf` exists and captures whatever the browser is showing, which
is the right tool for keeping a page that already exists and the wrong one for producing a
document: nothing in it controls where the pages break. A deliverable that has to be a PDF is
authored in Typst (`typst-pdf`); a deliverable that is a web page stays a web page.

## Stage 3 — mechanical checks

Run all of these. They are fast, they catch most real defects without a model, and not one of them
is something stage 0 already answered.

1. **Content that never reached a page.** Extract the text back out of the rendered PDF and compare
   it against the text you placed:
   `pdftotext -layout proofs/out.pdf proofs/out.txt`
   A word-count deficit above ~2% means content is missing rather than merely cut — a line pushed
   clean off a slide is absent from the render instead of reported crossing its edge, which is the
   half of overflow stage 0 structurally cannot see. It is also the only check anywhere that
   notices a loop that wrote nine of the twelve rows it was given.
2. **Placeholder scan.**
   `grep -n -E '\bTODO\b|\bLorem\b|\{\{|\bXXX\b|\bundefined\b|\bNaN\b|\bnan\b|\bNone\b|#REF!|#VALUE!|#N/A' proofs/out.txt`
   Any hit is a failure. `None` and `nan` catch Python values that leaked into a template. The word
   boundaries are load-bearing: an unbounded `nan` matches "finance", "maintenance" and
   "governance", so it fires on essentially every business document, and a check that always fires
   is a check that gets skipped.
3. **Embedded fonts.** `pdffonts proofs/out.pdf` — every row must show `yes` in the `emb` column.
   A `no` means the owner's machine substitutes and every line moves.
4. **Image resolution.** `pdfimages -list proofs/out.pdf` — flag any image whose x-ppi or y-ppi is
   below 110. Screenshots pasted at 72 dpi look soft in print.
5. **Spreadsheet recalculation.** For .xlsx only, recalculate and count error cells; the procedure
   is in `xlsx-authoring`. `error_cells` must be 0.
6. **Reading order, when a machine reads it before a human does.** For anything that will be parsed
   before it is read — a CV going into an applicant tracking system, an invoice going into a
   procurement system — `proofs/out.txt` from check 1 must contain the name, every date range and
   every heading in the order a person would read them. A multi-column layout looks best on screen and
   extracts as interleaved mush, which is what the parser stores and what a human is later shown.
   Rebuild it single-column; there is no fixing it downstream.

## Stage 4 — look at the pages

Stage 0 measured whether the pages are intact. Nothing so far has measured whether they are
_right_: a chart with the wrong axis label is ink in exactly the place ink belongs. That is what
this stage is for, and it is the only reason to spend a model on the images.

Call `image_read` on every rendered page, or at least the first, the last, and every page stage 0
or a stage 3 check named. Grade each against this fixed rubric and report pass/fail with one line
of reason, not prose:

- text overlapping other text or an image, which is measured nowhere else on purpose: a draft
  watermark under a paragraph and a caption over a photograph are overlaps that are correct work;
- text truncated with an ellipsis, or cut off inside its own box rather than at the page edge;
- a table whose right-hand columns are missing, or whose rows split across a page break mid-record;
- a chart with unlabelled axes, an unreadable legend, or overlapping category labels;
- body text below roughly 9pt, or contrast too low to read;
- inconsistent typography between sections, which is what template drift looks like;
- a page that carries nothing but a heading.

## Stage 5 — attach the proof

Publish the deliverable with `publish_artifact`, then attach the page images. The owner should be
able to see what the file looks like without opening it. `verification-evidence` treats a visual
deliverable with no proof set as incomplete.

## Failure modes

- **Grading only the first page.** Overflow accumulates: page 1 is usually fine and page 7 is where
  the table breaks.
- **Accepting a deficit as rounding.** A 15% word-count deficit is not rounding; it is a lost
  section. Find it.
- **Rendering the wrong file.** A stale PDF from a previous run passes every check in stages 3 and
  4 and describes nothing. Delete `proofs/` first, every time. Stage 0 is the one thing here that
  cannot be fooled this way, because the harness renders the deliverable itself.
- **Reading `pdffonts` too quickly.** `emb` is the third column, and a font can be Type 1 and still
  not embedded.
- **Mistaking a check that passed for a document that is right.** A .pptx whose zip is intact,
  whose slide count is the number that was asked for and whose every word sits inside the slide can
  still have half its bullets hidden behind the image beside them.
