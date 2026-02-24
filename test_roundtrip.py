#!/usr/bin/env python
"""Test export/import round-trip for SQLite format."""
import os
import django

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'docuweaver.settings')
django.setup()

from drawings.models import Project
from drawings.views import export_project_with_sqlite, import_project
from django.test import RequestFactory
from django.core.files.uploadedfile import SimpleUploadedFile

# Get first project
original_project = Project.objects.first()
print(f'Original Project: {original_project.name}')
print(f'  Assets: {original_project.assets.count()}')
print(f'  Links: {original_project.links.count()}')
print(f'  Layer Groups: {original_project.layer_groups.count()}')
print(f'  Sheets: {original_project.sheets.count()}')

# Export it
factory = RequestFactory()
request = factory.get(f'/project/{original_project.pk}/export-full/')
response = export_project_with_sqlite(request, original_project.pk)

print(f'\nExported {len(response.content)} bytes')

# Import it back
upload_file = SimpleUploadedFile(
    f'{original_project.name}.docuweaver',
    response.content,
    content_type='application/zip'
)

request = factory.post('/import/', {'file': upload_file})
request.FILES['file'] = upload_file
import_response = import_project(request)

print(f'\nImport response: {import_response.content.decode()}')

# Check the imported project
if import_response.status_code == 200:
    import json
    result = json.loads(import_response.content)
    new_project_id = result.get('project_id')
    
    if new_project_id:
        new_project = Project.objects.get(pk=new_project_id)
        print(f'\nImported Project: {new_project.name}')
        print(f'  Assets: {new_project.assets.count()}')
        print(f'  Links: {new_project.links.count()}')
        print(f'  Layer Groups: {new_project.layer_groups.count()}')
        print(f'  Sheets: {new_project.sheets.count()}')
        
        if new_project.assets.count() == original_project.assets.count():
            print('✓ Asset count matches!')
        else:
            print(f'✗ Asset count mismatch! Expected {original_project.assets.count()}, got {new_project.assets.count()}')
        
        if new_project.links.count() == original_project.links.count():
            print('✓ Link count matches!')
        else:
            print(f'✗ Link count mismatch! Expected {original_project.links.count()}, got {new_project.links.count()}')
