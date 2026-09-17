"""Regenerate the synthetic password fixture (requires reportlab and pypdf)."""
from io import BytesIO
from pathlib import Path
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader, PdfWriter

content = BytesIO()
canvas = Canvas(content, pagesize=(300, 200), invariant=True)
canvas.drawString(20, 170, 'Unlocked garden page')
canvas.save()
writer = PdfWriter()
writer.append_pages_from_reader(PdfReader(content))
writer.encrypt('garden-test', algorithm='AES-256')
with Path(__file__).with_name('password.pdf').open('wb') as output:
    writer.write(output)
