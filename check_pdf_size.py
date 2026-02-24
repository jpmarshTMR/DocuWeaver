import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'docuweaver.settings')
django.setup()
from drawings.models import Project
p = Project.objects.first()
print('Counting PDFs to read...')
total_bytes = 0
for sheet in p.sheets.all():
    if sheet.pdf_file and os.path.exists(sheet.pdf_file.path):
        size = os.path.getsize(sheet.pdf_file.path)
        total_bytes += size
        print(f'  {sheet.name}: {size:,} bytes')
print(f'Total PDF data to embed: {total_bytes:,} bytes ({total_bytes/1024/1024:.1f} MB)')
