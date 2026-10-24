import json
import sys
import textwrap
from pathlib import Path
from xml.sax.saxutils import escape

payload = json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))
output = Path(sys.argv[3])
output.parent.mkdir(parents=True, exist_ok=True)
article = payload['article']
report = payload.get('report', {})
full = report.get('scope', 'all') == 'all'
rows = payload.get('verification_results', [])
title = 'Verification full ledger' if full else 'Verification summary'
summary = (
    f"{report.get('total', len(rows))} statements | {report.get('attention', 0)} need attention | "
    f"{report.get('verified', 0)} verified | {report.get('not_applicable', 0)} no external check | "
    f"{report.get('pending', 0)} pending"
)
notes = ['No external check required does not mean verified. Missing evidence does not by itself establish that a claim is false.']
notes.extend((article.get('import_metadata') or {}).get('warnings', []))
evidence = payload.get('evidence', {})
notes.append(f"Evidence snapshot: {evidence['corpus_snapshot_id']} (frozen evidence)" if evidence.get('corpus_snapshot_id') else 'Legacy run: evidence was not frozen to source versions.')
if report.get('omitted'):
    notes.append(f"Showing the first {report['included']} priority findings. {report['omitted']} additional actionable findings are available in the workbench and the Full ledger export.")
if report.get('legacy_adjusted'):
    notes.append(f"{report['legacy_adjusted']} historical unsupported labels are displayed as no external check required, based on the original claim classification. Stored results have not been rewritten.")

if not full:
    notes.append('Summary excerpts are shortened. The full ledger contains complete assertions, comparisons, and evidence passages.')

def claim_text(row):
    text = row['assertion_as_made']
    return text if full else textwrap.shorten(text, width=280, placeholder='...')

def status(row):
    label = 'NO EXTERNAL CHECK REQUIRED' if row['status'] == 'NOT_APPLICABLE' else row['status']
    if row.get('original_status'):
        label += f" (original: {row['original_status']})"
    return label

def details(row):
    if not full:
        return [('Action', textwrap.shorten(row.get('recommended_remediation', ''), width=220, placeholder='...'))]
    fields = [('Gap', row.get('material_gap')), ('Action', row.get('recommended_remediation')),
              ('Evidence', row.get('extracted_passage')), ('Location', row.get('pin_cite')),
              ('Source', row.get('canonical_url'))]
    return [(label, value) for label, value in fields if value]

if sys.argv[1] == 'docx':
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    document = Document()
    section = document.sections[0]
    section.top_margin = section.bottom_margin = section.left_margin = section.right_margin = Inches(.8)
    normal = document.styles['Normal']
    normal.font.name = 'Calibri'
    normal.font.size = Pt(10)
    normal.paragraph_format.space_after = Pt(5)
    for name in ['Title', 'Heading 1', 'Heading 2']:
        document.styles[name].font.color.rgb = RGBColor.from_string('0B2545')
    document.add_heading(title, 0)
    document.add_paragraph(f"{article['title']} | Article version {article['version_number']}", 'Subtitle')
    document.add_paragraph(summary)
    for note in notes:
        document.add_paragraph(note)
    for index, row in enumerate(rows, 1):
        document.add_heading(f"{index}. {status(row)}", 2)
        claim_paragraph = document.add_paragraph(claim_text(row))
        if not full:
            claim_paragraph.paragraph_format.keep_with_next = True
        for label, value in details(row):
            paragraph = document.add_paragraph()
            paragraph.add_run(label + ': ').bold = True
            paragraph.add_run(str(value))
    if not rows:
        document.add_paragraph('No findings in this report scope.')
    if full:
        document.add_page_break()
        document.add_heading('Original article', 1)
        for block in article['content_markdown'].split('\n\n'):
            if block.strip():
                document.add_paragraph(block.strip())
    document.core_properties.author = 'Research Verification Workbench'
    document.save(output)
elif sys.argv[1] == 'pdf':
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether
    styles = getSampleStyleSheet()
    styles['BodyText'].fontSize = 9
    styles['BodyText'].leading = 12
    def paragraph(text, style='BodyText'):
        return Paragraph(escape(str(text)).replace('\n', '<br/>'), styles[style])
    story = [paragraph(title, 'Title'), paragraph(f"{article['title']} | Article version {article['version_number']}"), Spacer(1, 10), paragraph(summary)]
    story += [paragraph(note) for note in notes]
    for index, row in enumerate(rows, 1):
        block = [paragraph(f"{index}. {status(row)}", 'Heading2'), paragraph(claim_text(row))]
        block += [paragraph(f'{label}: {value}') for label, value in details(row)]
        block.append(Spacer(1, 6))
        story.extend(block if full else [KeepTogether(block)])
    if not rows:
        story.append(paragraph('No findings in this report scope.'))
    if full:
        story += [PageBreak(), paragraph('Original article', 'Heading1')]
        story += [paragraph(block.strip()) for block in article['content_markdown'].split('\n\n') if block.strip()]
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setFont('Helvetica', 8)
        canvas.drawRightString(letter[0] - 54, 30, f'Page {doc.page}')
        canvas.restoreState()
    SimpleDocTemplate(str(output), pagesize=letter, rightMargin=54, leftMargin=54, topMargin=54, bottomMargin=48,
                      title=title, author='Research Verification Workbench').build(story, onFirstPage=footer, onLaterPages=footer)
elif sys.argv[1] == 'xlsx':
    import xlsxwriter

    workbook = xlsxwriter.Workbook(str(output), {
        'strings_to_formulas': False,
        'strings_to_urls': False,
    })
    title_format = workbook.add_format({'bold': True, 'font_color': '#FFFFFF', 'bg_color': '#0B2545', 'font_size': 16})
    header_format = workbook.add_format({'bold': True, 'font_color': '#FFFFFF', 'bg_color': '#1F4D78', 'text_wrap': True, 'valign': 'vcenter'})
    label_format = workbook.add_format({'bold': True, 'bg_color': '#E8EEF5'})
    wrapped = workbook.add_format({'text_wrap': True, 'valign': 'top'})

    summary_sheet = workbook.add_worksheet('Summary')
    summary_sheet.hide_gridlines(2)
    summary_sheet.merge_range('A1:D1', 'Verification report', title_format)
    summary_rows = [
        ['Project', payload['project']['title']],
        ['Article', article['title']],
        ['Version', article['version_number']],
        ['Assertions', len(payload.get('assertions', []))],
        ['Verification results', len(rows)],
    ]
    for index, row in enumerate(summary_rows, 2):
        summary_sheet.write_row(index, 0, row)
        summary_sheet.write(index, 0, row[0], label_format)
    summary_sheet.set_column('A:D', 22)
    if report:
        report_rows = [
            ['Report scope', report.get('scope', 'all')],
            ['Needs attention', report.get('attention', 0)],
            ['Verified', report.get('verified', 0)],
            ['No external check', report.get('not_applicable', 0)],
            ['Pending', report.get('pending', 0)],
        ]
        for index, row in enumerate(report_rows, 8):
            summary_sheet.write_row(index, 0, row)
        summary_sheet.merge_range('A15:D15', 'No external check does not mean verified.')

    ledger = workbook.add_worksheet('Verification Ledger')
    ledger.hide_gridlines(2)
    ledger_headers = ['Assertion ID', 'Status', 'Assertion', 'Source establishes', 'Material gap', 'Pin cite', 'Defect codes', 'Remediation', 'Source URL']
    ledger_rows = [[row.get('assertion_id', ''), row.get('status', ''), row.get('assertion_as_made', ''),
                    row.get('source_actually_establishes', ''), row.get('material_gap', ''), row.get('pin_cite', ''),
                    ', '.join(row.get('defect_codes') or []), row.get('recommended_remediation', ''), row.get('canonical_url', '')]
                   for row in rows]
    ledger.write_row(0, 0, ledger_headers, header_format)
    for index, row in enumerate(ledger_rows, 1):
        ledger.write_row(index, 0, row, wrapped)
        ledger.set_row(index, 48)
    ledger.set_row(0, 28)
    for column, width in enumerate([38, 16, 42, 42, 38, 24, 28, 42, 48]):
        ledger.set_column(column, column, width)
    ledger.freeze_panes(1, 0)
    if ledger_rows:
        ledger.add_table(0, 0, len(ledger_rows), len(ledger_headers) - 1,
                         {'name': 'VerificationLedger', 'columns': [{'header': value} for value in ledger_headers]})

    sources_sheet = workbook.add_worksheet('Sources')
    source_headers = ['Source ID', 'Title', 'Type', 'Authority', 'Canonical URL', 'Status', 'Retrieved', 'SHA-256']
    source_rows = [[source.get('source_id', ''), source.get('title', ''), source.get('source_type', ''),
                    source.get('issuing_authority', ''), source.get('canonical_url', ''), source.get('retrieval_status', ''),
                    f"{str(source['retrieved_at'])[:10]} UTC" if source.get('retrieved_at') else '', source.get('content_hash', '')]
                   for source in payload.get('sources', [])]
    sources_sheet.write_row(0, 0, source_headers, header_format)
    for index, row in enumerate(source_rows, 1):
        sources_sheet.write_row(index, 0, row, wrapped)
        sources_sheet.set_row(index, 42)
    sources_sheet.set_row(0, 28)
    for column, width in enumerate([38, 28, 24, 26, 48, 18, 24, 68]):
        sources_sheet.set_column(column, column, width)
    sources_sheet.freeze_panes(1, 0)
    workbook.close()
else:
    raise ValueError('unsupported format')
