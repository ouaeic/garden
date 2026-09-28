---
name: docx-authoring
description: Produce or edit Word documents that open cleanly in Word with real heading styles, a working table of contents, headers and footers, tables and images, using python-docx to create and OOXML surgery to edit, then prove the result with a rendered page proof. Use when the deliverable is a .docx, a report, memo, letter, contract or CV in Word format, or when an existing Word file must be changed while keeping its template. Do not use for PDFs authored from scratch, for spreadsheets, or for plain Markdown deliverables.
license: AGPL-3.0-or-later
compatibility: garden-office-convert, poppler-utils, zip and unzip are installed on every supported host. python-docx comes from the host's own packages and Arch and openSUSE do not carry it, so on those the document toolchain reports office-authoring as unavailable rather than failing mid-procedure - read the runtime block before starting.
allowed-tools: shell file_read file_write files_list document_read image_read publish_artifact
metadata:
  garden.tier: 'builtin'
  garden.version: '2.1.0'
  garden.risk: 'workspace'
  garden.domain: 'documents'
---

# Word document authoring

Run every script here with `/usr/local/lib/garden/python/bin/python3`, which is the interpreter
with python-docx on it.

Write the content in Markdown first if the document is long — structure is easier to fix before it
is committed to OOXML. Then generate the .docx. Never hand the owner a Markdown file when they
asked for Word.

If the deliverable is a PDF rather than a Word file, do not write a .docx and convert it. Author it
with `typst-pdf`, which gives exact control of pagination. Converting a word-processor file gives
that control away, and pagination is what decides whether a CV is one page or two.

## Creating a new document

Use `python-docx`. Write a script into `workspace/build_doc.py` and run it; do not build the
document through a chain of one-liners, because you will re-run it after every correction.

Rules that decide whether the file looks professional:

- **Use styles, never direct formatting.** `doc.add_heading(text, level=1)` and
  `doc.add_paragraph(text, style='List Bullet')`. Setting bold and font size by hand produces a
  document with no navigation pane, no working TOC, and no way for the owner to restyle it.
- **Start from a template when one exists.** `Document('brand.dotx')` inherits the owner's styles.
  Delete the template's placeholder body content before adding yours:
  `for p in list(doc.paragraphs): p._element.getparent().remove(p._element)`.
- **Table of contents.** python-docx cannot build one directly; insert the field and let Word
  populate it. Add a paragraph, then append a `w:fldSimple` element with
  `instr='TOC \\o "1-3" \\h \\z \\u'`. The field shows "Right-click to update" until opened in
  Word — that is expected and correct. State it in the handover note.
- **Headers and footers.** `section = doc.sections[0]`, then `section.header.paragraphs[0]`. Page
  numbers need a `PAGE` field run, added the same way as the TOC field.
- **Tables.** `doc.add_table(rows=1, cols=n, style='Table Grid')`, add the header row, then
  `table.add_row()` per record. Set column widths on _every cell_ in a column, not on the column
  object — Word ignores the latter. Set `table.autofit = False` first.
- **Images.** `doc.add_picture(path, width=Inches(6.0))`. The usable text width on A4 with 2.5 cm
  margins is 6.3 inches, and on Letter with 1-inch margins 6.5 inches; going wider silently pushes
  the image off the page.
- **Page breaks.** `doc.add_page_break()` between major sections; do not fake them with empty
  paragraphs, which reflow.

## Editing an existing document

Do not round-trip an existing .docx through a generator; you will lose numbering, theme and
tracked changes. Two options, and the first is the default:

1. **python-docx in place** for content changes: open, walk `doc.paragraphs` and `doc.tables`,
   modify `run.text`, save to a _new_ path. Keep the original.
2. **OOXML surgery** only for what python-docx cannot express — a content control, a field, a
   custom XML part. Unzip, edit `word/document.xml`, rezip:
   ```
   mkdir -p work && cd work && unzip -q ../original.docx
   # edit word/document.xml
   zip -q -r -X ../edited.docx '[Content_Types].xml' _rels docProps word
   ```
   `-X` matters: extra attributes make Word complain about a corrupt file.

The trap in both cases is **run splitting**. Word splits a sentence across several `<w:r>` runs
wherever it recorded an edit, so the text you want to replace often does not exist as a contiguous
string anywhere in the XML. Before searching, merge adjacent runs that share identical `<w:rPr>`
formatting; then replace; then write back. Searching for "Total revenue" and finding nothing does
not mean it is absent.

## Verification

1. Reopen with python-docx and count paragraphs, headings and tables. A file that fails to reopen
   was written wrong. Confirm the headings really carry heading styles:
   `[p.style.name for p in doc.paragraphs if p.style.name.startswith('Heading')]` — an empty list
   here is why a TOC comes out empty.
2. `garden-office-convert out.docx proofs/out.pdf`, then `pdftoppm -jpeg -r 120 proofs/out.pdf
proofs/p`.
3. Run the rest of `render-proof`: placeholder scan, `pdffonts` embedding, image resolution and
   the round-trip word count that detects content lost off a page. Page count and blank pages are
   the acceptance render clause's, declared before the document was written.
4. Look at the pages with `image_read`. Check specifically: heading hierarchy consistent, tables
   not clipped on the right, images not overlapping text, no orphaned heading at a page bottom.
5. Publish with `publish_artifact` and attach the page images.

## Failure modes

- **Fonts.** A document specifying Calibri or Cambria renders in Carlito and Caladea where those
  are installed, which are metric-compatible, so the layout holds. Neither is packaged on every
  supported host - Caladea is absent on Arch and openSUSE, Carlito on openSUSE - so check with
  `fc-list | grep -i <family>` rather than assuming, and check any _other_ font the owner's
  template names the same way. A substitution that is not metric-compatible moves every line
  break, and the render proof is where you will see it.
- **The TOC that is empty.** A TOC field only fills in if the headings use real heading styles. An
  empty TOC in the proof means the styles were not applied.
- **Table columns that vanish.** A table wider than the text area is clipped at the margin in the
  PDF render, not wrapped. Sum your column widths.
- **Reporting success on the write.** `doc.save()` never fails on a document that will render
  badly. The proof is the render.
- **Converting to PDF as an afterthought.** If the owner asked for a PDF, they never wanted the
  .docx; author in Typst instead.
