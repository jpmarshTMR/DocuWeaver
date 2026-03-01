"""Tests for the models in the drawings app."""
from django.test import TestCase
from django.core.files.uploadedfile import SimpleUploadedFile
from ..models import Project, Sheet

# Helper functions
def make_pdf_file(name='test.pdf', size=None):
    """Create a minimal valid PDF file for testing."""
    content = b'%PDF-1.4 minimal test content'
    if size and size > len(content):
        content += b'\x00' * (size - len(content))
    return SimpleUploadedFile(name, content, content_type='application/pdf')

# ---------------------------------------------------------------------------
# Project Model Tests
# ---------------------------------------------------------------------------
class ProjectModelTests(TestCase):
    def test_create_with_defaults(self):
        p = Project.objects.create(name='Test Project')
        self.assertEqual(p.pixels_per_meter, 100.0)
        self.assertEqual(p.origin_x, 0.0)
        self.assertEqual(p.canvas_rotation, 0.0)
        self.assertEqual(p.asset_rotation, 0.0)
        self.assertEqual(p.ref_asset_id, '')

    def test_str(self):
        p = Project.objects.create(name='My Map')
        self.assertEqual(str(p), 'My Map')

# ---------------------------------------------------------------------------
# Sheet Model Tests
# ---------------------------------------------------------------------------
class SheetModelTests(TestCase):
    def setUp(self):
        self.project = Project.objects.create(name='Test Project')

    def test_create(self):
        s = Sheet.objects.create(
            project=self.project,
            name='Sheet A',
            pdf_file=make_pdf_file(),
        )
        self.assertEqual(s.page_number, 1)
        self.assertEqual(s.z_index, 0)
        self.assertEqual(s.cuts_json, [])

    def test_str(self):
        s = Sheet.objects.create(project=self.project, name='S1', pdf_file=make_pdf_file())
        self.assertEqual(str(s), 'S1 (Page 1)')

    def test_delete_removes_files(self):
        s = Sheet.objects.create(project=self.project, name='S1', pdf_file=make_pdf_file())
        pdf_name = s.pdf_file.name
        s.delete()
        # Add assertions to check file deletion logic
