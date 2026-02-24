import os
import sys
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'docuweaver.settings')
django.setup()

from drawings.models import Project

p = Project.objects.first()
print(f'Project: {p.name}')
print(f'Assets: {p.assets.count()}')
print(f'Links: {p.links.count()}')
print(f'Layer groups: {p.layer_groups.count()}')

# Check if PDFs exist
sheet = p.sheets.first()
if sheet and sheet.pdf_file:
    print(f'First sheet PDF exists: {os.path.exists(sheet.pdf_file.path)}')
    print(f'PDF path: {sheet.pdf_file.path}')
    print(f'PDF size: {os.path.getsize(sheet.pdf_file.path)} bytes')
else:
    print('No sheets or PDFs')

# Test export data building
print('\nTesting export data...')
assets_data = [
    {
        'asset_id': a.asset_id,
        'asset_type_name': a.asset_type.name,
        'layer_group_name': a.layer_group.name if a.layer_group else None,
    }
    for a in p.assets.all()[:5]  # Just first 5
]
print(f'Sample assets: {assets_data}')
