"""API views for drawings app."""
import json
from django.shortcuts import get_object_or_404
from django.http import JsonResponse, HttpResponse
from rest_framework import generics, status
from rest_framework.decorators import api_view
from rest_framework.response import Response

from .models import Project, Sheet, Asset, AdjustmentLog, AssetType
from .serializers import (
    ProjectSerializer, ProjectListSerializer,
    SheetSerializer, AssetSerializer, AdjustmentLogSerializer
)
from .services.pdf_processor import render_pdf_page
from .services.csv_importer import import_assets_from_csv
from .services.export_service import export_sheet_with_overlays, generate_adjustment_report


class ProjectListCreate(generics.ListCreateAPIView):
    queryset = Project.objects.all()

    def get_serializer_class(self):
        if self.request.method == 'GET':
            return ProjectListSerializer
        return ProjectSerializer


class ProjectDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Project.objects.all()
    serializer_class = ProjectSerializer


class SheetListCreate(generics.ListCreateAPIView):
    serializer_class = SheetSerializer

    def get_queryset(self):
        return Sheet.objects.filter(project_id=self.kwargs['project_pk'])

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        sheet = serializer.save(project=project)
        # Render the PDF page to an image
        render_pdf_page(sheet)


class SheetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Sheet.objects.all()
    serializer_class = SheetSerializer


@api_view(['POST'])
def render_sheet(request, pk):
    """Re-render a sheet's PDF to image."""
    sheet = get_object_or_404(Sheet, pk=pk)
    try:
        render_pdf_page(sheet)
        return Response({
            'status': 'success',
            'rendered_image': request.build_absolute_uri(sheet.rendered_image.url),
            'width': sheet.image_width,
            'height': sheet.image_height
        })
    except Exception as e:
        return Response({'status': 'error', 'message': str(e)}, status=500)


class AssetListCreate(generics.ListCreateAPIView):
    serializer_class = AssetSerializer

    def get_queryset(self):
        return Asset.objects.filter(project_id=self.kwargs['project_pk'])

    def perform_create(self, serializer):
        project = get_object_or_404(Project, pk=self.kwargs['project_pk'])
        serializer.save(project=project)


class AssetDetail(generics.RetrieveUpdateDestroyAPIView):
    queryset = Asset.objects.all()
    serializer_class = AssetSerializer


@api_view(['POST'])
def adjust_asset(request, pk):
    """Adjust an asset's position and log the change."""
    asset = get_object_or_404(Asset, pk=pk)

    new_x = request.data.get('x')
    new_y = request.data.get('y')
    notes = request.data.get('notes', '')

    if new_x is None or new_y is None:
        return Response({'error': 'x and y coordinates required'}, status=400)

    # Get the "from" coordinates
    from_x = asset.current_x
    from_y = asset.current_y

    # Create adjustment log
    AdjustmentLog.objects.create(
        asset=asset,
        from_x=from_x,
        from_y=from_y,
        to_x=float(new_x),
        to_y=float(new_y),
        notes=notes
    )

    # Update asset
    asset.adjusted_x = float(new_x)
    asset.adjusted_y = float(new_y)
    asset.is_adjusted = True
    asset.save()

    serializer = AssetSerializer(asset)
    return Response(serializer.data)


@api_view(['POST'])
def import_csv(request, project_pk):
    """Import assets from CSV file."""
    project = get_object_or_404(Project, pk=project_pk)

    if 'file' not in request.FILES:
        return Response({'error': 'No file provided'}, status=400)

    csv_file = request.FILES['file']
    try:
        result = import_assets_from_csv(project, csv_file)
        return Response(result)
    except Exception as e:
        return Response({'error': str(e)}, status=400)


@api_view(['POST'])
def export_project(request, project_pk):
    """Export sheets with asset overlays as PDFs."""
    project = get_object_or_404(Project, pk=project_pk)
    sheet_ids = request.data.get('sheet_ids', [])

    if not sheet_ids:
        sheets = project.sheets.all()
    else:
        sheets = project.sheets.filter(id__in=sheet_ids)

    try:
        results = []
        for sheet in sheets:
            output_path = export_sheet_with_overlays(sheet, project.assets.all())
            results.append({
                'sheet_id': sheet.id,
                'sheet_name': sheet.name,
                'output_path': output_path
            })
        return Response({'status': 'success', 'exports': results})
    except Exception as e:
        return Response({'error': str(e)}, status=500)


@api_view(['GET'])
def adjustment_report(request, project_pk):
    """Generate adjustment report for a project."""
    project = get_object_or_404(Project, pk=project_pk)
    format_type = request.query_params.get('format', 'json')

    adjusted_assets = project.assets.filter(is_adjusted=True)
    logs = AdjustmentLog.objects.filter(asset__project=project).order_by('-timestamp')

    if format_type == 'csv':
        return generate_adjustment_report(project, adjusted_assets, logs, format_type='csv')

    # JSON response
    report = {
        'project': project.name,
        'total_assets': project.assets.count(),
        'adjusted_count': adjusted_assets.count(),
        'adjustments': AdjustmentLogSerializer(logs, many=True).data,
        'summary': []
    }

    for asset in adjusted_assets:
        report['summary'].append({
            'asset_id': asset.asset_id,
            'name': asset.name,
            'original': {'x': asset.original_x, 'y': asset.original_y},
            'adjusted': {'x': asset.adjusted_x, 'y': asset.adjusted_y},
            'delta_distance': asset.delta_distance,
            'adjustment_count': asset.adjustment_logs.count()
        })

    return Response(report)


@api_view(['POST'])
def calibrate_project(request, pk):
    """Set scale calibration for a project."""
    project = get_object_or_404(Project, pk=pk)

    # For scale calibration: provide two pixel points and the real-world distance
    pixel_distance = request.data.get('pixel_distance')
    real_distance = request.data.get('real_distance')  # in meters

    if pixel_distance and real_distance:
        project.pixels_per_meter = float(pixel_distance) / float(real_distance)

    # For origin setting
    origin_x = request.data.get('origin_x')
    origin_y = request.data.get('origin_y')

    if origin_x is not None:
        project.origin_x = float(origin_x)
    if origin_y is not None:
        project.origin_y = float(origin_y)

    project.save()

    return Response({
        'pixels_per_meter': project.pixels_per_meter,
        'origin_x': project.origin_x,
        'origin_y': project.origin_y
    })
