"""Service for fetching and transforming Queensland cadastre data."""
import logging
import requests
from typing import Dict, List, Tuple, Optional
from django.core.cache import cache
from django.conf import settings

logger = logging.getLogger(__name__)

# Queensland Spatial Services API endpoint
QSPATIAL_BASE_URL = "https://spatial-gis.information.qld.gov.au/arcgis/rest/services"
CADASTRE_LAYER_URL = f"{QSPATIAL_BASE_URL}/PlanningCadastre/LandParcelPropertyFramework/MapServer/0/query"

# Cache timeout: 1 hour (cadastre data doesn't change frequently)
CADASTRE_CACHE_TIMEOUT = 3600


def fetch_cadastre_boundaries(lat: float, lon: float, radius_meters: int = 500) -> Optional[Dict]:
    """
    Fetch cadastral boundaries from Queensland Government API.
    
    Args:
        lat: Latitude (WGS84)
        lon: Longitude (WGS84)
        radius_meters: Search radius in meters (default 500, max 2000)
    
    Returns:
        GeoJSON FeatureCollection or None if error
    """
    # Limit radius to prevent excessive data
    radius_meters = min(max(radius_meters, 50), 2000)
    
    # Create cache key based on location and radius
    cache_key = f"cadastre_{lat:.6f}_{lon:.6f}_{radius_meters}"
    
    # Check cache first
    cached_data = cache.get(cache_key)
    if cached_data:
        logger.info(f"Returning cached cadastre data for {lat}, {lon}")
        return cached_data
    
    try:
        # Prepare API request
        params = {
            'geometry': f'{lon},{lat}',
            'geometryType': 'esriGeometryPoint',
            'distance': radius_meters,
            'units': 'esriSRUnit_Meter',
            'spatialRel': 'esriSpatialRelIntersects',
            'outFields': 'LOT,PLAN,PARCEL_TYPE,TENURE,LOCALITY,LOCAL_GOVERNMENT',
            'returnGeometry': 'true',
            'f': 'geojson',
            'outSR': '4326'  # WGS84
        }
        
        logger.info(f"Fetching cadastre data for lat={lat}, lon={lon}, radius={radius_meters}m")
        
        response = requests.get(CADASTRE_LAYER_URL, params=params, timeout=30)
        response.raise_for_status()
        
        geojson_data = response.json()
        
        # Validate response
        if 'features' not in geojson_data:
            logger.warning(f"Invalid GeoJSON response: {geojson_data}")
            return None
        
        feature_count = len(geojson_data.get('features', []))
        logger.info(f"Fetched {feature_count} cadastre features")
        
        # Cache the result
        cache.set(cache_key, geojson_data, CADASTRE_CACHE_TIMEOUT)
        
        return geojson_data
        
    except requests.RequestException as e:
        logger.error(f"Failed to fetch cadastre data: {e}")
        return None
    except Exception as e:
        logger.error(f"Unexpected error fetching cadastre data: {e}")
        return None


def transform_cadastre_to_project_coords(geojson_features: Dict, project) -> List[Dict]:
    """
    Transform cadastre GeoJSON features from lat/lon to project pixel coordinates.
    
    Args:
        geojson_features: GeoJSON FeatureCollection
        project: Project model instance
    
    Returns:
        List of transformed features with pixel coordinates
    """
    from ..models import Asset
    
    transformed_features = []
    
    if not geojson_features or 'features' not in geojson_features:
        return transformed_features
    
    # Get reference point
    ref_asset = None
    if project.ref_asset_id:
        ref_asset = Asset.objects.filter(
            project=project, 
            asset_id=project.ref_asset_id
        ).first()
    
    if not ref_asset:
        logger.warning("No reference asset found for cadastre transformation")
        return transformed_features
    
    ref_lat = ref_asset.current_y
    ref_lon = ref_asset.current_x
    ref_pixel_x = project.ref_pixel_x
    ref_pixel_y = project.ref_pixel_y
    
    # Get project parameters
    ppm = project.pixels_per_meter
    asset_rotation_deg = project.asset_rotation
    
    if not ppm or ppm <= 0:
        logger.warning(f"Invalid pixels_per_meter: {ppm}")
        return transformed_features
    
    for feature in geojson_features['features']:
        geometry = feature.get('geometry')
        properties = feature.get('properties', {})
        
        if not geometry or geometry['type'] not in ['Polygon', 'MultiPolygon']:
            continue
        
        # Transform geometry coordinates
        transformed_geometry = transform_geometry(
            geometry, ref_lat, ref_lon, ref_pixel_x, ref_pixel_y,
            ppm, asset_rotation_deg
        )
        
        transformed_features.append({
            'type': 'Feature',
            'geometry': transformed_geometry,
            'properties': properties
        })
    
    return transformed_features


def transform_geometry(
    geometry: Dict,
    ref_lat: float,
    ref_lon: float,
    ref_pixel_x: float,
    ref_pixel_y: float,
    ppm: float,
    asset_rotation_deg: float
) -> Dict:
    """
    Transform a GeoJSON geometry from lat/lon to pixel coordinates.
    
    Args:
        geometry: GeoJSON geometry object
        ref_lat: Reference latitude
        ref_lon: Reference longitude
        ref_pixel_x: Reference pixel X
        ref_pixel_y: Reference pixel Y
        ppm: Pixels per meter
        asset_rotation_deg: Asset layer rotation in degrees
    
    Returns:
        Transformed geometry with pixel coordinates
    """
    import math
    
    geom_type = geometry['type']
    coordinates = geometry['coordinates']
    
    if geom_type == 'Polygon':
        # Polygon: array of rings (first is outer, rest are holes)
        transformed_coords = [
            transform_ring(ring, ref_lat, ref_lon, ref_pixel_x, ref_pixel_y, ppm, asset_rotation_deg)
            for ring in coordinates
        ]
    elif geom_type == 'MultiPolygon':
        # MultiPolygon: array of polygons
        transformed_coords = [
            [
                transform_ring(ring, ref_lat, ref_lon, ref_pixel_x, ref_pixel_y, ppm, asset_rotation_deg)
                for ring in polygon
            ]
            for polygon in coordinates
        ]
    else:
        transformed_coords = coordinates
    
    return {
        'type': geom_type,
        'coordinates': transformed_coords
    }


def transform_ring(
    ring: List[List[float]],
    ref_lat: float,
    ref_lon: float,
    ref_pixel_x: float,
    ref_pixel_y: float,
    ppm: float,
    asset_rotation_deg: float
) -> List[List[float]]:
    """
    Transform a coordinate ring from lat/lon to pixel coordinates.
    
    Args:
        ring: Array of [lon, lat] coordinates
        ref_lat: Reference latitude
        ref_lon: Reference longitude
        ref_pixel_x: Reference pixel X
        ref_pixel_y: Reference pixel Y
        ppm: Pixels per meter
        asset_rotation_deg: Asset layer rotation in degrees
    
    Returns:
        Array of [pixel_x, pixel_y] coordinates
    """
    import math
    
    transformed_ring = []
    
    for coord in ring:
        lon, lat = coord[0], coord[1]
        
        # Calculate offset from reference point in degrees
        d_lon = lon - ref_lon
        d_lat = lat - ref_lat
        
        # Convert to meters using equirectangular approximation
        # At the reference latitude
        center_lat_rad = ref_lat * math.pi / 180
        meters_x = d_lon * 111320 * math.cos(center_lat_rad)
        meters_y = -(d_lat * 111320)  # Negate: lat increases up, canvas Y increases down
        
        # Apply asset layer rotation
        rad = asset_rotation_deg * math.pi / 180
        cos_r = math.cos(rad)
        sin_r = math.sin(rad)
        
        rot_x = meters_x * cos_r - meters_y * sin_r
        rot_y = meters_x * sin_r + meters_y * cos_r
        
        # Convert to pixels and offset from reference pixel
        pixel_x = ref_pixel_x + (rot_x * ppm)
        pixel_y = ref_pixel_y + (rot_y * ppm)
        
        transformed_ring.append([pixel_x, pixel_y])
    
    return transformed_ring


def clear_cadastre_cache(project_id: int):
    """Clear cached cadastre data for a project."""
    # This is a simple implementation - in production you might want
    # to track cache keys more precisely
    cache.delete_pattern(f"cadastre_*")
    logger.info(f"Cleared cadastre cache for project {project_id}")
