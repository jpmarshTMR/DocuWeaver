#!/usr/bin/env python
"""Quick script to check layer groups in database."""
import os
import sys
import django

# Setup Django
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'pdftool.settings')
django.setup()

from drawings.models import LayerGroup, Link, Asset

print("=== Layer Groups ===")
for g in LayerGroup.objects.all():
    print(f"ID:{g.id}, Name:'{g.name}', Type:{g.group_type}, Project:{g.project_id}")

print("\n=== Links with layer_group ===")
for l in Link.objects.exclude(layer_group=None)[:10]:
    print(f"Link ID:{l.id}, Name:'{l.name}', layer_group:{l.layer_group_id}")

print("\n=== Assets with layer_group ===")
for a in Asset.objects.exclude(layer_group=None)[:10]:
    print(f"Asset ID:{a.id}, Name:'{a.asset_id}', layer_group:{a.layer_group_id}")
