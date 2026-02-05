"""Page views for drawings app."""
from django.shortcuts import render, get_object_or_404
from .models import Project, AssetType


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
