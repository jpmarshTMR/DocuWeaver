"""CSV import service for asset data."""
import csv
import io
from django.db import transaction
from ..models import Asset, AssetType


def import_assets_from_csv(project, csv_file):
    """
    Import assets from a CSV file into a project.

    Expected CSV format:
    asset_id,asset_type,x,y,name,description,...

    - asset_id: Unique identifier (required)
    - asset_type: Must match an AssetType name (required)
    - x, y: Coordinates in meters (required)
    - Additional columns are stored as metadata

    Args:
        project: Project model instance
        csv_file: Uploaded file object

    Returns:
        dict with import results
    """
    # Read the CSV content
    content = csv_file.read()
    if isinstance(content, bytes):
        content = content.decode('utf-8-sig')  # Handle BOM if present

    reader = csv.DictReader(io.StringIO(content))

    # Validate required columns
    fieldnames = reader.fieldnames
    required_columns = ['asset_id', 'asset_type', 'x', 'y']
    missing = [col for col in required_columns if col not in fieldnames]
    if missing:
        raise ValueError(f"Missing required columns: {', '.join(missing)}")

    # Get or create asset types
    asset_types_cache = {at.name.lower(): at for at in AssetType.objects.all()}

    results = {
        'created': 0,
        'updated': 0,
        'errors': [],
        'assets': []
    }

    with transaction.atomic():
        for row_num, row in enumerate(reader, start=2):  # Start at 2 (1-indexed + header)
            try:
                # Validate required fields
                asset_id = row.get('asset_id', '').strip()
                asset_type_name = row.get('asset_type', '').strip()
                x_str = row.get('x', '').strip()
                y_str = row.get('y', '').strip()

                if not asset_id:
                    results['errors'].append(f"Row {row_num}: Missing asset_id")
                    continue

                if not asset_type_name:
                    results['errors'].append(f"Row {row_num}: Missing asset_type")
                    continue

                # Parse coordinates
                try:
                    x = float(x_str)
                    y = float(y_str)
                except ValueError:
                    results['errors'].append(f"Row {row_num}: Invalid coordinates (x={x_str}, y={y_str})")
                    continue

                # Get or create asset type
                asset_type_key = asset_type_name.lower()
                if asset_type_key not in asset_types_cache:
                    # Create new asset type with defaults
                    asset_type = AssetType.objects.create(name=asset_type_name)
                    asset_types_cache[asset_type_key] = asset_type
                else:
                    asset_type = asset_types_cache[asset_type_key]

                # Build metadata from extra columns
                metadata = {}
                for key, value in row.items():
                    if key not in required_columns and key != 'name' and value:
                        metadata[key] = value

                # Get optional name
                name = row.get('name', '').strip()

                # Create or update asset
                asset, created = Asset.objects.update_or_create(
                    project=project,
                    asset_id=asset_id,
                    defaults={
                        'asset_type': asset_type,
                        'name': name,
                        'original_x': x,
                        'original_y': y,
                        'metadata': metadata,
                    }
                )

                if created:
                    results['created'] += 1
                else:
                    results['updated'] += 1

                results['assets'].append({
                    'asset_id': asset_id,
                    'created': created,
                    'x': x,
                    'y': y
                })

            except Exception as e:
                results['errors'].append(f"Row {row_num}: {str(e)}")

    return results


def validate_csv_format(csv_file):
    """
    Validate CSV format without importing.

    Returns dict with validation results.
    """
    content = csv_file.read()
    if isinstance(content, bytes):
        content = content.decode('utf-8-sig')

    # Reset file position for potential reuse
    csv_file.seek(0)

    reader = csv.DictReader(io.StringIO(content))
    fieldnames = reader.fieldnames

    required_columns = ['asset_id', 'asset_type', 'x', 'y']
    missing = [col for col in required_columns if col not in fieldnames]

    # Count rows
    row_count = sum(1 for _ in reader)

    return {
        'valid': len(missing) == 0,
        'columns': fieldnames,
        'missing_columns': missing,
        'row_count': row_count
    }
