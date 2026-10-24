import tempfile
import unittest
import zipfile
from pathlib import Path
from extract_article import extract_docx, extract_pdf

class ExtractionCoverage(unittest.TestCase):
    def test_word_order_notes_and_warnings(self):
        with tempfile.TemporaryDirectory() as root:
            filename=Path(root)/'fixture.docx'
            with zipfile.ZipFile(filename,'w') as archive:
                archive.writestr('word/document.xml','''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Before table</w:t><w:footnoteReference w:id="1"/></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table value</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After table</w:t></w:r></w:p><w:altChunk/></w:body></w:document>''')
                for kind in ['footnote','endnote']:
                    archive.writestr(f'word/{kind}s.xml',f'<w:{kind}s xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:{kind} w:id="1"><w:p><w:r><w:t>Material {kind}</w:t></w:r></w:p></w:{kind}></w:{kind}s>')
                archive.writestr('word/header1.xml','<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Material header</w:t></w:r></w:p></w:hdr>')
                archive.writestr('word/media/image1.png',b'fixture')
            result=extract_docx(filename)
            text=result['text']
            self.assertLess(text.index('Before table'),text.index('Table value'))
            self.assertLess(text.index('Table value'),text.index('After table'))
            for expected in ['[footnote 1]','Material footnote','Material endnote','Material header']: self.assertIn(expected,text)
            self.assertEqual(result['coverage']['notes_extracted'],2)
            self.assertFalse(result['coverage']['original_document_complete'])
            self.assertTrue(any('alternative-format' in w for w in result['warnings']))
            self.assertTrue(any('Images' in w for w in result['warnings']))

    def test_xml_entity_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            filename=Path(root)/'fixture.docx'
            with zipfile.ZipFile(filename,'w') as archive: archive.writestr('word/document.xml','<!DOCTYPE foo [<!ENTITY boom "unsafe">]><x/>')
            with self.assertRaises(ValueError): extract_docx(filename)

    def test_xml_entity_rejected_in_utf16_and_utf32_parts(self):
        doctype='<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE foo [<!ENTITY boom "unsafe">]><x/>'
        for encoding in ('utf-16','utf-16-le','utf-16-be','utf-32'):
            with tempfile.TemporaryDirectory() as root:
                filename=Path(root)/'fixture.docx'
                with zipfile.ZipFile(filename,'w') as archive: archive.writestr('word/document.xml',doctype.encode(encoding))
                with self.assertRaises(ValueError, msg=encoding): extract_docx(filename)

    def test_pdf_text_visuals_and_image_only_rejection(self):
        from reportlab.pdfgen import canvas
        from reportlab.lib.utils import ImageReader
        from PIL import Image
        with tempfile.TemporaryDirectory() as root:
            filename=Path(root)/'fixture.pdf'
            image=ImageReader(Image.new('RGB',(10,10),'black'))
            pdf=canvas.Canvas(str(filename));pdf.drawString(72,720,'Native fixture text');pdf.drawImage(image,72,600,10,10);pdf.save()
            result=extract_pdf(filename)
            self.assertIn('Native fixture text',result['text'])
            self.assertTrue(any('OCR was not performed' in w for w in result['warnings']))
            pdf=canvas.Canvas(str(filename));pdf.drawImage(image,72,600,10,10);pdf.save()
            with self.assertRaisesRegex(ValueError,'OCR'): extract_pdf(filename)

if __name__=='__main__': unittest.main()
