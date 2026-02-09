"""Add cuts_json field and migrate existing crop data."""
from django.db import migrations, models


def forward_migrate_cuts(apps, schema_editor):
    """Convert flat crop fields to cuts_json array."""
    Sheet = apps.get_model('drawings', 'Sheet')
    for sheet in Sheet.objects.all():
        if sheet.crop_x != 0 or sheet.crop_y != 0 or sheet.crop_width != 0 or sheet.crop_height != 0:
            sheet.cuts_json = [{
                'p1': {'x': sheet.crop_x, 'y': sheet.crop_y},
                'p2': {'x': sheet.crop_width, 'y': sheet.crop_height},
                'flipped': sheet.crop_flipped,
            }]
        else:
            sheet.cuts_json = []
        sheet.save(update_fields=['cuts_json'])


def reverse_migrate_cuts(apps, schema_editor):
    """Convert cuts_json back to flat crop fields (keeps first cut only)."""
    Sheet = apps.get_model('drawings', 'Sheet')
    for sheet in Sheet.objects.all():
        if sheet.cuts_json and len(sheet.cuts_json) > 0:
            first_cut = sheet.cuts_json[0]
            sheet.crop_x = first_cut['p1']['x']
            sheet.crop_y = first_cut['p1']['y']
            sheet.crop_width = first_cut['p2']['x']
            sheet.crop_height = first_cut['p2']['y']
            sheet.crop_flipped = first_cut.get('flipped', False)
        else:
            sheet.crop_x = 0
            sheet.crop_y = 0
            sheet.crop_width = 0
            sheet.crop_height = 0
            sheet.crop_flipped = False
        sheet.save(update_fields=['crop_x', 'crop_y', 'crop_width', 'crop_height', 'crop_flipped'])


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0003_add_crop_flipped'),
    ]

    operations = [
        migrations.AddField(
            model_name='sheet',
            name='cuts_json',
            field=models.JSONField(
                blank=True,
                default=list,
                help_text='Array of cut definitions: [{p1: {x, y}, p2: {x, y}, flipped: bool}, ...]',
            ),
        ),
        migrations.RunPython(forward_migrate_cuts, reverse_migrate_cuts),
    ]
