"""Tests for the validators in the drawings app."""
from django.core.exceptions import ValidationError
from django.test import TestCase
from django.core.files.uploadedfile import SimpleUploadedFile
from ..validators import PDFFileValidator, ImageFileValidator

# Helper functions
def make_pdf_file(name='test.pdf', size=None):
    """Create a minimal valid PDF file for testing."""
    content = b'%PDF-1.4 minimal test content'
    if size and size > len(content):
        content += b'\x00' * (size - len(content))
    return SimpleUploadedFile(name, content, content_type='application/pdf')

def make_png_file(name='test.png', size=None):
    """Create a minimal valid PNG file for testing."""
    content = b'\x89PNG\r\n\x1a\n' + b'\x00' * 50
    if size and size > len(content):
        content += b'\x00' * (size - len(content))
    return SimpleUploadedFile(name, content, content_type='image/png')

# ---------------------------------------------------------------------------
# PDF Validator Tests
# ---------------------------------------------------------------------------
class PDFValidatorTests(TestCase):
    def setUp(self):
        self.validator = PDFFileValidator()

    def test_valid_pdf(self):
        file = make_pdf_file()
        self.validator(file)

    def test_invalid_pdf_extension(self):
        file = make_pdf_file(name='test.txt')
        with self.assertRaises(ValidationError):
            self.validator(file)

    def test_invalid_pdf_header(self):
        file = SimpleUploadedFile('test.pdf', b'Invalid content', content_type='application/pdf')
        with self.assertRaises(ValidationError):
            self.validator(file)

# ---------------------------------------------------------------------------
# Image Validator Tests
# ---------------------------------------------------------------------------
class ImageValidatorTests(TestCase):
    def setUp(self):
        self.validator = ImageFileValidator()

    def test_valid_png(self):
        file = make_png_file()
        self.validator(file)

    def test_invalid_png_extension(self):
        file = make_png_file(name='test.txt')
        with self.assertRaises(ValidationError):
            self.validator(file)

    def test_invalid_png_header(self):
        file = SimpleUploadedFile('test.png', b'Invalid content', content_type='image/png')
        with self.assertRaises(ValidationError):
            self.validator(file)
