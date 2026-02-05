"""URL configuration for drawings app views."""
from django.urls import path
from . import views

app_name = 'drawings'

urlpatterns = [
    path('', views.project_list, name='project_list'),
    path('project/<int:pk>/', views.project_detail, name='project_detail'),
    path('project/<int:pk>/editor/', views.editor, name='editor'),
]
