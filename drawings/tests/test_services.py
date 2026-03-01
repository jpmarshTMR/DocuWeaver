"""Tests for the services in the drawings app."""
from django.test import TestCase
from django.core.files.uploadedfile import SimpleUploadedFile
from ..services.csv_importer import import_assets_from_csv
from ..models import Project, AssetType, ImportBatch, Asset

# Helper functions
def make_csv_content(rows, fieldnames=None):
    """Build an in-memory CSV file from rows."""
    import io, csv
    if fieldnames is None:
        fieldnames = rows[0].keys() if rows else []
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    buf.seek(0)
    return SimpleUploadedFile('test.csv', buf.getvalue().encode('utf-8'), content_type='text/csv')

# ---------------------------------------------------------------------------
# CSV Importer Tests
# ---------------------------------------------------------------------------
class CSVImporterTests(TestCase):
    def setUp(self):
        self.project = Project.objects.create(name='Test Project')
        self.asset_type = AssetType.objects.create(name='Manhole')

    def test_import_valid_csv(self):
        rows = [
            {'name': 'Asset 1', 'type': self.asset_type.name},
            {'name': 'Asset 2', 'type': self.asset_type.name},
        ]
        csv_file = make_csv_content(rows)
        import_assets_from_csv(self.project, csv_file)
        self.assertEqual(Asset.objects.count(), 2)
        self.assertEqual(ImportBatch.objects.count(), 1)

    def test_import_invalid_csv(self):
        rows = [
            {'name': 'Asset 1'},  # Missing 'type' field
        ]
        csv_file = make_csv_content(rows)
        with self.assertRaises(ValueError):
            import_assets_from_csv(self.project, csv_file)
