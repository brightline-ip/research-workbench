import codecs
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

def xml_text(data):
    """Decode an XML part by its BOM / declared encoding, as the XML parser will, so the entity guard sees real characters."""
    boms = [(codecs.BOM_UTF32_LE, 'utf-32'), (codecs.BOM_UTF32_BE, 'utf-32'), (codecs.BOM_UTF8, 'utf-8-sig'),
            (codecs.BOM_UTF16_LE, 'utf-16'), (codecs.BOM_UTF16_BE, 'utf-16')]
    encoding = next((name for bom, name in boms if data.startswith(bom)), None)
    if encoding is None:
        head = data[:4]
        if head == b'\x00\x00\x00<': encoding = 'utf-32-be'
        elif head == b'<\x00\x00\x00': encoding = 'utf-32-le'
        elif head[:2] == b'\x00<': encoding = 'utf-16-be'
        elif head[:2] == b'<\x00': encoding = 'utf-16-le'
        else:
            declared = re.match(rb'<\?xml[^>]*?encoding\s*=\s*["\']([A-Za-z0-9._-]+)["\']', data[:256])
            encoding = declared.group(1).decode('ascii') if declared else 'utf-8'
    try:
        return data.decode(encoding)
    except (LookupError, UnicodeDecodeError):
        raise ValueError('XML part uses an unsupported or invalid encoding')

def check_no_entities(data):
    text = xml_text(data).upper()
    if '<!DOCTYPE' in text or '<!ENTITY' in text:
        raise ValueError('XML entity definitions are unsupported')

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'

def extract_docx(source):
    warnings = []
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > 10000 or sum(i.file_size for i in infos) > 100 * 1024 * 1024:
            raise ValueError('Expanded DOCX exceeds extraction limits')
        names = set(archive.namelist())
        def read(name):
            data = archive.read(name)
            check_no_entities(data)
            return ET.fromstring(data)
        def paragraph(node):
            parts = []
            for item in node.iter():
                if item.tag == W+'t': parts.append(item.text or '')
                elif item.tag == W+'tab': parts.append('\t')
                elif item.tag in (W+'br', W+'cr'): parts.append('\n')
                elif item.tag in (W+'footnoteReference', W+'endnoteReference'):
                    parts.append(f" [{item.tag.split('}')[1].replace('Reference', '')} {item.get(W+'id')}]")
            return ''.join(parts).strip()
        def blocks(node):
            result = []
            for child in node:
                if child.tag == W+'p':
                    text = paragraph(child)
                    if text: result.append(text)
                elif child.tag == W+'tbl':
                    for row in child.findall(W+'tr'):
                        result.append(' | '.join(' / '.join(blocks(cell)) for cell in row.findall(W+'tc')))
                else: result.extend(blocks(child))
            return result
        document = read('word/document.xml')
        output = blocks(document.find(W+'body'))
        note_count = 0
        for kind in ('footnote', 'endnote'):
            filename = f'word/{kind}s.xml'
            if filename in names:
                for note in read(filename):
                    if note.get(W+'type') in ('separator', 'continuationSeparator'): continue
                    text = '\n\n'.join(blocks(note))
                    if text:
                        output.append(f"[{kind} {note.get(W+'id')}]\n\n{text}")
                        note_count += 1
        extras = sorted(n for n in names if n.startswith(('word/header','word/footer')) and n.endswith('.xml'))
        if 'word/comments.xml' in names: extras.append('word/comments.xml')
        for name in extras:
            text = '\n\n'.join(blocks(read(name)))
            if text: output.append(f'[{Path(name).stem}]\n\n{text}')
        if any(n.startswith(('word/media/', 'word/charts/', 'word/embeddings/')) for n in names):
            warnings.append('Images, charts and embedded objects require visual review; their content is not certified by text extraction.')
        if next(document.iter(W+'altChunk'), None) is not None:
            warnings.append('Embedded alternative-format content was not extracted. Review the original before verification.')
        if next(document.iter(W+'del'), None) is not None or next(document.iter(W+'ins'), None) is not None:
            warnings.append('Tracked changes exist. Inserted text is included and deleted text is omitted; review the intended revision.')
        warnings.append('Text extraction does not verify layout, fields, numbering or visual content against the original.')
        return {'text':'\n\n'.join(output), 'warnings':warnings, 'coverage':{'method':'DOCX_XML', 'notes_extracted':note_count, 'original_document_complete':False}}

def extract_pdf(source):
    from pypdf import PdfReader
    reader = PdfReader(str(source))
    pages, missing, blank, visual = [], [], [], []
    for index, page in enumerate(reader.pages, 1):
        text = (page.extract_text() or '').strip()
        objects = (page.get('/Resources') or {}).get('/XObject')
        if objects: visual.append(index)
        if text: pages.append(f'<!-- PDF page {index} -->\n\n{text}')
        elif objects: missing.append(index)
        else: blank.append(index)
    if missing: raise ValueError(f'Image-only PDF pages need OCR: {missing}')
    warnings = ['PDF native-text extraction does not verify reading order, tables or visual content against the original.']
    if visual: warnings.append(f'Pages with visual objects require review: {visual}. OCR was not performed.')
    if blank: warnings.append(f'Pages without extractable text: {blank}. Confirm these are blank in the original.')
    return {'text':'\n\n'.join(pages), 'warnings':warnings, 'coverage':{'method':'PDF_NATIVE_TEXT','pages':len(reader.pages),'pages_with_text':len(pages),'original_document_complete':False}}

if __name__ == '__main__':
    source, kind = Path(sys.argv[1]), sys.argv[2].lower()
    result = extract_docx(source) if kind == '.docx' else extract_pdf(source) if kind == '.pdf' else None
    if not result or not result['text'].strip(): raise ValueError('No extractable article text was found')
    sys.stdout.write(json.dumps(result, ensure_ascii=False) if '--json' in sys.argv else result['text'])
