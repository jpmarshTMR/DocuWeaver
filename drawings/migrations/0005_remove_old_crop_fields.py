"""Remove old flat crop fields now that cuts_json is in place."""
from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('drawings', '0004_add_cuts_json'),
    ]

    operations = [
        migrations.RemoveField(model_name='sheet', name='crop_x'),
        migrations.RemoveField(model_name='sheet', name='crop_y'),
        migrations.RemoveField(model_name='sheet', name='crop_width'),
        migrations.RemoveField(model_name='sheet', name='crop_height'),
        migrations.RemoveField(model_name='sheet', name='crop_flipped'),
    ]
