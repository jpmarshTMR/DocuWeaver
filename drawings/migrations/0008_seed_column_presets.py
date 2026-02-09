"""Seed default column presets for CSV import mapping."""
from django.db import migrations


def seed_presets(apps, schema_editor):
    ColumnPreset = apps.get_model('drawings', 'ColumnPreset')
    defaults = [
        ('asset_id', 'asset_id', 0),
        ('asset_id', 'TN', 10),
        ('asset_id', 'intersection', 5),
        ('asset_type', 'asset_type', 0),
        ('x', 'x', 0),
        ('x', 'X', 0),
        ('y', 'y', 0),
        ('y', 'Y', 0),
        ('name', 'name', 0),
    ]
    for role, col_name, priority in defaults:
        ColumnPreset.objects.get_or_create(
            role=role,
            column_name=col_name,
            defaults={'priority': priority}
        )


def remove_presets(apps, schema_editor):
    ColumnPreset = apps.get_model('drawings', 'ColumnPreset')
    ColumnPreset.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0007_add_column_preset'),
    ]

    operations = [
        migrations.RunPython(seed_presets, remove_presets),
    ]
