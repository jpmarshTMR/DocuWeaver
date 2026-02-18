"""Page views for drawings app."""
import os
import json
import zipfile
from io import BytesIO
from django.shortcuts import render, get_object_or_404
from django.http import HttpResponse, JsonResponse
from django.conf import settings
from django.core.files.base import ContentFile
from django.views.decorators.http import require_POST
from django.db import transaction
from .models import (
    Project, Sheet, JoinMark, AssetType, ImportBatch, Asset,
    Link, LayerGroup, MeasurementSet
)


def project_list(request):
    """List all projects."""
    projects = Project.objects.all()
    return render(request, 'drawings/project_list.html', {'projects': projects})


def project_detail(request, pk):
    """View project details."""
    project = get_object_or_404(Project, pk=pk)
    return render(request, 'drawings/project_detail.html', {'project': project})


def editor(request, pk):
    """Main canvas editor for a project."""
    project = get_object_or_404(Project, pk=pk)
    asset_types = AssetType.objects.all()
    return render(request, 'drawings/editor.html', {
        'project': project,
        'asset_types': asset_types,
    })


def export_project(request, pk):
    """Export a project as a ZIP file containing JSON data and media files."""
    project = get_object_or_404(Project, pk=pk)
    
    # Create in-memory ZIP file
    zip_buffer = BytesIO()
    
    with zipfile.ZipFile(zip_buffer, 'w', zipfile.ZIP_DEFLATED) as zf:
        # Export project data
        project_data = {
            'name': project.name,
            'description': project.description,
            'pixels_per_meter': project.pixels_per_meter,
            'scale_calibrated': project.scale_calibrated,
            'coord_unit': project.coord_unit,
            'origin_x': project.origin_x,
            'origin_y': project.origin_y,
            'canvas_rotation': project.canvas_rotation,
            'asset_rotation': project.asset_rotation,
            'ref_asset_id': project.ref_asset_id,
            'ref_pixel_x': project.ref_pixel_x,
            'ref_pixel_y': project.ref_pixel_y,
            'cadastre_color': project.cadastre_color,
        }
        
        # Export sheets
        sheets_data = []
        pdf_files = {}  # Track unique PDF files
        rendered_files = {}  # Track rendered images
        
        for sheet in project.sheets.all():
            sheet_data = {
                'name': sheet.name,
                'page_number': sheet.page_number,
                'cuts_json': sheet.cuts_json,
                'offset_x': sheet.offset_x,
                'offset_y': sheet.offset_y,
                'rotation': sheet.rotation,
                'z_index': sheet.z_index,
                'image_width': sheet.image_width,
                'image_height': sheet.image_height,
                'layer_group_name': sheet.layer_group.name if sheet.layer_group else None,
            }
            
            # Track PDF file
            if sheet.pdf_file:
                pdf_name = os.path.basename(sheet.pdf_file.name)
                sheet_data['pdf_file'] = pdf_name
                if pdf_name not in pdf_files:
                    pdf_files[pdf_name] = sheet.pdf_file.path
            
            # Track rendered image
            if sheet.rendered_image:
                rendered_name = os.path.basename(sheet.rendered_image.name)
                sheet_data['rendered_image'] = rendered_name
                if rendered_name not in rendered_files:
                    rendered_files[rendered_name] = sheet.rendered_image.path
            
            # Export join marks
            sheet_data['join_marks'] = [
                {'x': jm.x, 'y': jm.y, 'reference_label': jm.reference_label}
                for jm in sheet.join_marks.all()
            ]
            
            sheets_data.append(sheet_data)
        
        # Export asset types
        asset_types_data = []
        icon_files = {}
        
        for at in AssetType.objects.filter(assets__project=project).distinct():
            at_data = {
                'name': at.name,
                'icon_shape': at.icon_shape,
                'color': at.color,
                'size': at.size,
            }
            if at.custom_icon:
                icon_name = os.path.basename(at.custom_icon.name)
                at_data['custom_icon'] = icon_name
                if icon_name not in icon_files:
                    icon_files[icon_name] = at.custom_icon.path
            asset_types_data.append(at_data)
        
        # Export import batches
        batches_data = []
        for batch in project.import_batches.all():
            batches_data.append({
                'id': batch.id,
                'filename': batch.filename,
                'asset_count': batch.asset_count,
            })
        
        # Export assets
        assets_data = []
        for asset in project.assets.all():
            assets_data.append({
                'asset_id': asset.asset_id,
                'asset_type_name': asset.asset_type.name,
                'import_batch_id': asset.import_batch_id,
                'layer_group_name': asset.layer_group.name if asset.layer_group else None,
                'name': asset.name,
                'original_x': asset.original_x,
                'original_y': asset.original_y,
                'adjusted_x': asset.adjusted_x,
                'adjusted_y': asset.adjusted_y,
                'is_adjusted': asset.is_adjusted,
                'metadata': asset.metadata,
            })
        
        # Export links
        links_data = []
        for link in project.links.all():
            links_data.append({
                'link_id': link.link_id,
                'import_batch_id': link.import_batch_id,
                'layer_group_name': link.layer_group.name if link.layer_group else None,
                'name': link.name,
                'coordinates': link.coordinates,
                'color': link.color,
                'width': link.width,
                'opacity': link.opacity,
                'link_type': link.link_type,
                'metadata': link.metadata,
            })
        
        # Export layer groups
        groups_data = []
        for group in project.layer_groups.all():
            groups_data.append({
                'name': group.name,
                'group_type': group.group_type,
                'color': group.color,
                'visible': group.visible,
                'parent_group_name': group.parent_group.name if group.parent_group else None,
            })
        
        # Export measurement sets
        measurements_data = []
        for ms in project.measurement_sets.all():
            measurements_data.append({
                'name': ms.name,
                'measurement_type': ms.measurement_type,
                'points': ms.points,
                'color': ms.color,
                'visible': ms.visible,
                'total_distance_pixels': ms.total_distance_pixels,
                'total_distance_meters': ms.total_distance_meters,
            })
        
        # Combine all data
        export_data = {
            'version': '1.0',
            'project': project_data,
            'sheets': sheets_data,
            'asset_types': asset_types_data,
            'import_batches': batches_data,
            'assets': assets_data,
            'links': links_data,
            'layer_groups': groups_data,
            'measurement_sets': measurements_data,
        }
        
        # Write JSON data
        zf.writestr('project.json', json.dumps(export_data, indent=2))
        
        # Add PDF files
        for name, path in pdf_files.items():
            if os.path.exists(path):
                zf.write(path, f'pdfs/{name}')
        
        # Add rendered images
        for name, path in rendered_files.items():
            if os.path.exists(path):
                zf.write(path, f'rendered/{name}')
        
        # Add custom icons
        for name, path in icon_files.items():
            if os.path.exists(path):
                zf.write(path, f'icons/{name}')
    
    # Prepare response
    zip_buffer.seek(0)
    response = HttpResponse(zip_buffer.read(), content_type='application/zip')
    response['Content-Disposition'] = f'attachment; filename="{project.name}.docuweaver"'
    return response


@require_POST
def import_project(request):
    """Import a project from an uploaded ZIP file."""
    if 'file' not in request.FILES:
        return JsonResponse({'error': 'No file uploaded'}, status=400)
    
    uploaded_file = request.FILES['file']
    
    if not uploaded_file.name.endswith('.docuweaver'):
        return JsonResponse({'error': 'Invalid file type. Please upload a .docuweaver file'}, status=400)
    
    try:
        with zipfile.ZipFile(uploaded_file, 'r') as zf:
            # Read project data
            try:
                project_json = zf.read('project.json')
                data = json.loads(project_json)
            except KeyError:
                return JsonResponse({'error': 'Invalid project file: missing project.json'}, status=400)
            
            with transaction.atomic():
                # Create project
                project_data = data['project']
                
                # Check for duplicate name and modify if needed
                base_name = project_data['name']
                name = base_name
                counter = 1
                while Project.objects.filter(name=name).exists():
                    name = f"{base_name} ({counter})"
                    counter += 1
                
                project = Project.objects.create(
                    name=name,
                    description=project_data.get('description', ''),
                    pixels_per_meter=project_data.get('pixels_per_meter', 100.0),
                    scale_calibrated=project_data.get('scale_calibrated', False),
                    coord_unit=project_data.get('coord_unit', 'meters'),
                    origin_x=project_data.get('origin_x', 0.0),
                    origin_y=project_data.get('origin_y', 0.0),
                    canvas_rotation=project_data.get('canvas_rotation', 0.0),
                    asset_rotation=project_data.get('asset_rotation', 0.0),
                    ref_asset_id=project_data.get('ref_asset_id', ''),
                    ref_pixel_x=project_data.get('ref_pixel_x', 0.0),
                    ref_pixel_y=project_data.get('ref_pixel_y', 0.0),
                    cadastre_color=project_data.get('cadastre_color', '#FF6600'),
                )
                
                # Create or get asset types
                asset_type_map = {}
                for at_data in data.get('asset_types', []):
                    at, created = AssetType.objects.get_or_create(
                        name=at_data['name'],
                        defaults={
                            'icon_shape': at_data.get('icon_shape', 'circle'),
                            'color': at_data.get('color', '#FF0000'),
                            'size': at_data.get('size', 20),
                        }
                    )
                    # Handle custom icon
                    if at_data.get('custom_icon'):
                        try:
                            icon_data = zf.read(f"icons/{at_data['custom_icon']}")
                            at.custom_icon.save(at_data['custom_icon'], ContentFile(icon_data), save=True)
                        except KeyError:
                            pass
                    asset_type_map[at_data['name']] = at
                
                # Create layer groups (first pass - without parent references)
                group_map = {}
                for g_data in data.get('layer_groups', []):
                    group = LayerGroup.objects.create(
                        project=project,
                        name=g_data['name'],
                        group_type=g_data['group_type'],
                        color=g_data.get('color', '#3498db'),
                        visible=g_data.get('visible', True),
                    )
                    group_map[g_data['name']] = group
                
                # Set parent groups (second pass)
                for g_data in data.get('layer_groups', []):
                    if g_data.get('parent_group_name'):
                        group = group_map.get(g_data['name'])
                        parent = group_map.get(g_data['parent_group_name'])
                        if group and parent:
                            group.parent_group = parent
                            group.save()
                
                # Create import batches
                batch_map = {}
                for b_data in data.get('import_batches', []):
                    batch = ImportBatch.objects.create(
                        project=project,
                        filename=b_data['filename'],
                        asset_count=b_data.get('asset_count', 0),
                    )
                    batch_map[b_data['id']] = batch
                
                # Create sheets
                for s_data in data.get('sheets', []):
                    sheet = Sheet(
                        project=project,
                        name=s_data['name'],
                        page_number=s_data.get('page_number', 1),
                        cuts_json=s_data.get('cuts_json', []),
                        offset_x=s_data.get('offset_x', 0.0),
                        offset_y=s_data.get('offset_y', 0.0),
                        rotation=s_data.get('rotation', 0.0),
                        z_index=s_data.get('z_index', 0),
                        image_width=s_data.get('image_width', 0),
                        image_height=s_data.get('image_height', 0),
                    )
                    
                    # Set layer group
                    if s_data.get('layer_group_name'):
                        sheet.layer_group = group_map.get(s_data['layer_group_name'])
                    
                    # Handle PDF file
                    if s_data.get('pdf_file'):
                        try:
                            pdf_data = zf.read(f"pdfs/{s_data['pdf_file']}")
                            sheet.pdf_file.save(s_data['pdf_file'], ContentFile(pdf_data), save=False)
                        except KeyError:
                            pass
                    
                    # Handle rendered image
                    if s_data.get('rendered_image'):
                        try:
                            img_data = zf.read(f"rendered/{s_data['rendered_image']}")
                            sheet.rendered_image.save(s_data['rendered_image'], ContentFile(img_data), save=False)
                        except KeyError:
                            pass
                    
                    sheet.save()
                    
                    # Create join marks
                    for jm_data in s_data.get('join_marks', []):
                        JoinMark.objects.create(
                            sheet=sheet,
                            x=jm_data['x'],
                            y=jm_data['y'],
                            reference_label=jm_data['reference_label'],
                        )
                
                # Create assets
                for a_data in data.get('assets', []):
                    asset_type = asset_type_map.get(a_data['asset_type_name'])
                    if not asset_type:
                        asset_type, _ = AssetType.objects.get_or_create(name=a_data['asset_type_name'])
                    
                    Asset.objects.create(
                        project=project,
                        asset_type=asset_type,
                        import_batch=batch_map.get(a_data.get('import_batch_id')),
                        layer_group=group_map.get(a_data.get('layer_group_name')),
                        asset_id=a_data['asset_id'],
                        name=a_data.get('name', ''),
                        original_x=a_data['original_x'],
                        original_y=a_data['original_y'],
                        adjusted_x=a_data.get('adjusted_x'),
                        adjusted_y=a_data.get('adjusted_y'),
                        is_adjusted=a_data.get('is_adjusted', False),
                        metadata=a_data.get('metadata', {}),
                    )
                
                # Create links
                for l_data in data.get('links', []):
                    Link.objects.create(
                        project=project,
                        import_batch=batch_map.get(l_data.get('import_batch_id')),
                        layer_group=group_map.get(l_data.get('layer_group_name')),
                        link_id=l_data['link_id'],
                        name=l_data.get('name', ''),
                        coordinates=l_data['coordinates'],
                        color=l_data.get('color', '#0066FF'),
                        width=l_data.get('width', 2),
                        opacity=l_data.get('opacity', 1.0),
                        link_type=l_data.get('link_type', 'other'),
                        metadata=l_data.get('metadata', {}),
                    )
                
                # Create measurement sets
                for ms_data in data.get('measurement_sets', []):
                    MeasurementSet.objects.create(
                        project=project,
                        name=ms_data['name'],
                        measurement_type=ms_data.get('measurement_type', 'single'),
                        points=ms_data.get('points', []),
                        color=ms_data.get('color', '#00bcd4'),
                        visible=ms_data.get('visible', True),
                        total_distance_pixels=ms_data.get('total_distance_pixels'),
                        total_distance_meters=ms_data.get('total_distance_meters'),
                    )
                
                return JsonResponse({
                    'status': 'success',
                    'project_id': project.id,
                    'project_name': project.name,
                })
    
    except zipfile.BadZipFile:
        return JsonResponse({'error': 'Invalid ZIP file'}, status=400)
    except json.JSONDecodeError:
        return JsonResponse({'error': 'Invalid JSON data in project file'}, status=400)
    except Exception as e:
        return JsonResponse({'error': f'Import failed: {str(e)}'}, status=500)
