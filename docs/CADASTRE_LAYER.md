# Queensland Cadastre Layer Feature

## Overview

The Cadastre Layer feature allows you to overlay Queensland property boundaries on your engineering drawings, providing visual context for asset positioning and alignment. The layer is fully interactive - you can drag, rotate, and customize it to match your drawings.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Features](#features)
3. [How to Use](#how-to-use)
4. [Downloading Cadastre Data](#downloading-cadastre-data)
5. [Troubleshooting](#troubleshooting)
6. [Technical Details](#technical-details)

---

## Quick Start

### Prerequisites
- A project with PDF sheets uploaded
- Assets imported with Queensland coordinates (lat/lon)
- Scale calibrated (recommended but optional)

### 5-Minute Setup

1. **Set Reference Point**
   - Assets → Verify & Plot
   - Select coordinate unit: "Lat/Lon Degrees (WGS84)"
   - Choose a reference asset with known coordinates
   - Click on the drawing where that asset should be
   - Click "Apply"

2. **Load Cadastre Data**
   
   **Option A: API (Automatic)**
   - Expand "Cadastre Layer" panel in sidebar
   - Toggle "Enable Layer" ON
   - Wait 2-5 seconds for data to load
   
   **Option B: File Upload (If API Fails)**
   - Click "📁 Upload GeoJSON"
   - Select your downloaded cadastre file
   - See [Downloading Data](#downloading-cadastre-data) section

3. **Align the Layer**
   - Press '2' to switch to Select mode
   - Click on any property boundary line
   - Drag to align with your drawings
   - Rotate using corner handles if needed

4. **Customize**
   - Adjust opacity slider (recommended: 40-60%)
   - Change color if needed (red by default)
   - Toggle visibility checkbox to show/hide

---

## Features

### Interactive Layer Management
- ✅ **Draggable**: Click and drag the entire layer to align with drawings
- ✅ **Rotatable**: Use corner handles to rotate the layer
- ✅ **Selectable**: Click to select, shows green borders
- ✅ **Visibility Toggle**: Quick show/hide without unloading data

### Data Loading Options
- ✅ **Queensland API**: Automatic fetching from QLD Spatial Services
- ✅ **File Upload**: Upload GeoJSON files manually
- ✅ **Caching**: 1-hour cache to reduce API calls
- ✅ **Auto-refresh**: Reloads when reference point changes

### Customization
- ✅ **Opacity Control**: 0-100% transparency slider
- ✅ **Color Picker**: Choose any line color
- ✅ **Feature Count**: Shows number of properties loaded
- ✅ **Settings Persistence**: Saved to database

### Canvas Integration
- ✅ **Layer Ordering**: Behind sheets, above background
- ✅ **Coordinate Transform**: Automatic lat/lon to pixel conversion
- ✅ **Multi-geometry**: Supports Polygon and MultiPolygon
- ✅ **Selection Feedback**: Visual indication when selected

---

## How to Use

### Setting Up Your Project

#### 1. Import Assets with Coordinates

Your CSV must include latitude and longitude columns:

```csv
asset_id,name,latitude,longitude,type
POLE001,Power Pole,-27.4705,153.0260,Pole
PIT002,Inspection Pit,-27.4710,153.0265,Pit
VALVE003,Water Valve,-27.4715,153.0270,Valve
```

**Coordinate System Options:**
- WGS84 Lat/Lon (decimal degrees)
- GDA94 Geographic (Lat/Lon)
- GDA94 MGA (Easting/Northing with zone)

#### 2. Calibrate Your Drawing (Recommended)

1. Click the "Calibrate" tool
2. Click two points on your drawing with known distance
3. Enter the real-world distance in meters
4. This ensures accurate positioning

#### 3. Set Reference Point

The reference point anchors the asset layer to the drawing:

1. Open **Assets → Verify & Plot** panel
2. Select coordinate unit matching your CSV
3. Choose a reference asset (one you can see on the drawing)
4. Click on the drawing where that asset is located
5. Click **Apply**

💡 **Tip**: Choose a distinctive asset like a corner pole or major structure that's clearly visible on both the drawing and in your data.

### Loading Cadastre Data

#### Method 1: Queensland API (Automatic)

**When to use:** You have internet connection and the API is working

**Steps:**
1. Expand the **Cadastre Layer** panel
2. Toggle **Enable Layer** switch ON
3. Wait 2-5 seconds
4. Property boundaries appear as red lines

**What it does:**
- Fetches data within 500m radius of reference point
- Queries Queensland Spatial Services REST API
- Caches results for 1 hour
- Transforms coordinates automatically

#### Method 2: Upload GeoJSON File

**When to use:** 
- API returns errors
- You need offline capability
- You have pre-processed data
- You want a specific area/dataset

**Steps:**
1. Download cadastre data (see [Downloading Data](#downloading-cadastre-data))
2. Click **📁 Upload GeoJSON** button
3. Select your `.geojson` or `.json` file
4. Property boundaries appear immediately

**Benefits:**
- Works offline
- No API limits
- Use custom datasets
- Faster for large areas

### Aligning the Layer

The cadastre layer is a **draggable overlay** that you manually align:

1. **Switch to Select Mode**
   - Click the Select tool (cursor icon)
   - Or press '2' on your keyboard

2. **Select the Layer**
   - Click on any property boundary line
   - Green selection borders appear
   - Layer becomes draggable

3. **Drag to Align**
   - Click and drag the layer
   - Align property corners with drawing features
   - Use recognizable landmarks (road intersections, lot corners)

4. **Rotate if Needed**
   - Grab the corner handles
   - Rotate to match drawing orientation
   - Fine-tune alignment

5. **Deselect**
   - Press ESC or click elsewhere
   - Continue working with other tools

💡 **Alignment Tips:**
- Use 40-60% opacity to see both layers clearly
- Look for distinctive features: road corners, lot boundaries
- Engineering drawings may have slight rotations
- Check multiple points to verify alignment
- Save your work frequently

### Customizing Appearance

#### Opacity Slider
- **Range:** 0% (invisible) to 100% (opaque)
- **Default:** 70%
- **Recommended:** 40-60% for overlay work
- **Use case:** Lower opacity lets you see the drawing underneath

#### Color Picker
- **Default:** Red (#FF0000)
- **Options:** Any hex color
- **Suggestions:**
  - Red (#FF0000) - High visibility
  - Cyan (#00FFFF) - Good on dark backgrounds
  - Yellow (#FFFF00) - High contrast
  - Magenta (#FF00FF) - Distinct from engineering colors
  - Green (#00FF00) - Natural/survey color

#### Visibility Toggle
- **Location:** Checkbox in panel header
- **Function:** Quick show/hide
- **Difference from Enable:** Data stays loaded, just hidden

### Working with the Layer

Once aligned, use the cadastre layer to:

1. **Position Assets**
   - See where assets should be relative to properties
   - Verify assets are on correct lots
   - Check for property boundary issues

2. **Visual Reference**
   - Understand site context
   - Identify property relationships
   - Plan infrastructure placement

3. **Verification**
   - Cross-check asset positions
   - Validate surveyed locations
   - Identify discrepancies

4. **Documentation**
   - Take screenshots with layer visible
   - Export with property boundaries shown
   - Create reports with spatial context

---

## Downloading Cadastre Data

If the Queensland API fails or you need offline data:

### Option 1: Queensland Spatial Catalogue (Official)

**Best for:** Authoritative, up-to-date data

1. Visit: https://qldspatial.information.qld.gov.au/catalogue/
2. Search for: "Digital Cadastral Database" or "DCDB"
3. Select your region:
   - Brisbane City
   - Gold Coast City
   - Sunshine Coast Regional
   - Toowoomba Regional
   - Cairns Regional
   - Townsville City
   - Other LGAs
4. Download format: **GeoJSON** (preferred)
5. Save to your computer

### Option 2: Queensland Open Data Portal

**Best for:** Alternative access to official data

1. Visit: https://www.data.qld.gov.au/
2. Search: "cadastre" or "land parcels"
3. Filter by Format: GeoJSON or JSON
4. Filter by Organization: Department of Resources
5. Download the dataset

### Option 3: Using QGIS (Advanced)

**Best for:** Converting other formats or clipping to specific areas

#### Install QGIS
- Free, open-source GIS software
- Download: https://qgis.org/

#### Convert Shapefiles to GeoJSON

1. **Load Data**
   - Layer → Add Layer → Add Vector Layer
   - Browse to your `.shp` file
   - Click Add

2. **Clip to Area (Optional)**
   - Vector → Geoprocessing Tools → Clip
   - Input: Your cadastre layer
   - Overlay: Draw area or use boundary
   - Run

3. **Export as GeoJSON**
   - Right-click layer → Export → Save Features As
   - Format: **GeoJSON**
   - CRS: **EPSG:4326 - WGS 84** (Important!)
   - Filename: `cadastre.geojson`
   - Click OK

#### Why WGS84?
DocuWeaver expects coordinates in WGS84 (EPSG:4326) with [longitude, latitude] order. If your data is in a different coordinate system, QGIS will reproject it automatically.

### Option 4: OpenStreetMap (Alternative)

**Best for:** When official data is unavailable

⚠️ **Warning:** OSM data may be incomplete or less accurate

1. Visit: https://overpass-turbo.eu/
2. Navigate to your area of interest
3. Use this query:
```
[out:json];
(
  way["boundary"="cadastral"]({{bbox}});
  relation["boundary"="cadastral"]({{bbox}});
);
out geom;
```
4. Click **Run**
5. Export → GeoJSON
6. Save file

### File Format Requirements

DocuWeaver expects standard GeoJSON format:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": {
        "type": "Polygon",
        "coordinates": [
          [
            [153.0260, -27.4705],
            [153.0265, -27.4705],
            [153.0265, -27.4710],
            [153.0260, -27.4710],
            [153.0260, -27.4705]
          ]
        ]
      },
      "properties": {
        "LOT": "1",
        "PLAN": "RP12345",
        "LOCALITY": "Brisbane"
      }
    }
  ]
}
```

**Requirements:**
- ✅ Coordinate system: WGS84 (EPSG:4326)
- ✅ Coordinate order: [longitude, latitude]
- ✅ Geometry types: Polygon or MultiPolygon
- ✅ Valid JSON structure
- ✅ "features" array must exist

### Validating Your File

Before uploading, validate your GeoJSON:

**Online Validators:**
- http://geojson.io/ - View on map + validate
- https://geojsonlint.com/ - Check syntax

**Quick Manual Check:**
1. Open in text editor
2. Starts with `{"type": "FeatureCollection"`?
3. Has `"features": [...]` array?
4. Coordinates are numbers, not strings?
5. Queensland coordinates roughly: 138-154°E, 10-29°S

---

## Troubleshooting

### API Errors

#### "Failed to fetch cadastre data from Queensland API"

**Causes:**
- API is temporarily down
- Network connectivity issues
- Rate limiting
- Authentication requirements
- CORS restrictions

**Solutions:**
1. **Use File Upload** (Recommended)
   - Click "📁 Upload GeoJSON"
   - Upload pre-downloaded data
   
2. **Check Network**
   - Test internet connection
   - Try from different network
   - Check firewall settings

3. **Try Again Later**
   - API may be temporarily down
   - Wait 10-15 minutes and retry

4. **Contact Support**
   - Queensland Spatial Services
   - Report persistent issues

### Reference Point Issues

#### "Set a reference point first"

**Cause:** Cadastre layer requires a reference point for coordinate transformation

**Solution:**
1. Go to Assets → Verify & Plot
2. Select a reference asset
3. Click on drawing where it's located
4. Click Apply

#### "Reference asset not found"

**Cause:** Selected reference asset was deleted or doesn't exist

**Solution:**
1. Import assets if you haven't
2. Choose a different reference asset
3. Re-apply verification

### File Upload Issues

#### "Invalid GeoJSON format"

**Causes:**
- File is not valid JSON
- Missing "features" array
- Incorrect structure

**Solutions:**
1. Validate at http://geojson.io/
2. Check file structure matches requirements
3. Ensure it's a FeatureCollection
4. Try re-exporting from QGIS

#### "File too large"

**Causes:**
- Very large cadastre dataset
- Too many features
- Unoptimized geometry

**Solutions:**
1. Use QGIS to clip to smaller area
2. Simplify geometries (Geometry → Simplify)
3. Split into multiple files
4. Remove unnecessary properties

### Display Issues

#### "Boundaries don't appear"

**Causes:**
- Wrong coordinate system
- Coordinates outside canvas area
- Layer disabled or invisible
- No data loaded

**Solutions:**
1. Check coordinates are WGS84
2. Verify reference point is correct
3. Check visibility toggle is ON
4. Check opacity isn't set to 0%
5. Look at browser console (F12) for errors

#### "Boundaries in wrong location"

**Causes:**
- Coordinate order reversed (lat/lon vs lon/lat)
- Wrong coordinate system
- Reference point incorrect
- Drawing not georeferenced

**Solutions:**
1. Check coordinate order in GeoJSON
2. Should be [longitude, latitude]
3. Re-verify reference point
4. Try manual alignment with drag feature

#### "Can't drag the layer"

**Causes:**
- Not in Select mode
- Layer not selected
- Different object selected

**Solutions:**
1. Press '2' to switch to Select mode
2. Click directly on a property line
3. Look for green selection borders
4. Press ESC and try again

### Performance Issues

#### "Rendering is slow"

**Causes:**
- Too many features
- Complex geometries
- Large file size

**Solutions:**
1. Reduce opacity (less rendering work)
2. Toggle visibility when not needed
3. Use QGIS to simplify geometries
4. Clip to smaller area
5. Close other browser tabs

---

## Technical Details

### Architecture

#### Frontend
- **Library:** Fabric.js 5.3.1
- **Rendering:** HTML5 Canvas
- **Layer Type:** fabric.Group containing fabric.Polyline objects
- **Interaction:** Draggable, rotatable, selectable
- **Storage:** localStorage for client state

#### Backend
- **Framework:** Django 4.2 + Django REST Framework
- **Service:** `drawings/services/cadastre_service.py`
- **API:** Queensland Spatial Services REST API
- **Caching:** Django cache framework (1-hour timeout)
- **Database:** SQLite (cadastre settings per project)

### API Endpoints

#### GET `/api/projects/<pk>/cadastre/`
Fetch cadastre data from Queensland API

**Parameters:**
- `radius` (optional): Search radius in meters (default: 500, max: 2000)

**Response:**
```json
{
  "features": [...],
  "reference_point": {
    "lat": -27.4705,
    "lon": 153.0260
  },
  "feature_count": 150
}
```

#### POST `/api/projects/<pk>/cadastre/upload/`
Upload and process GeoJSON file

**Request Body:** GeoJSON FeatureCollection

**Response:**
```json
{
  "features": [...],
  "feature_count": 150,
  "message": "Successfully loaded 150 cadastre features"
}
```

#### POST `/api/projects/<pk>/cadastre/settings/`
Update cadastre layer settings

**Request Body:**
```json
{
  "cadastre_enabled": true,
  "cadastre_opacity": 0.7,
  "cadastre_color": "#FF0000"
}
```

### Coordinate Transformation

The service transforms coordinates through multiple steps:

1. **Input:** GeoJSON with WGS84 lat/lon coordinates
2. **Reference Point:** Project's reference asset provides anchor
3. **Meters Conversion:** Lat/lon → meters using equirectangular approximation
4. **Rotation:** Apply project's asset layer rotation
5. **Pixel Conversion:** Meters → pixels using project's scale
6. **Canvas Position:** Add reference pixel offset

Formula (simplified):
```python
# Lat/lon to meters (relative to reference)
meters_x = (lon - ref_lon) * meters_per_degree_lon
meters_y = (lat - ref_lat) * meters_per_degree_lat

# Rotate
rotated_x = meters_x * cos(θ) - meters_y * sin(θ)
rotated_y = meters_x * sin(θ) + meters_y * cos(θ)

# To pixels
pixel_x = rotated_x * pixels_per_meter + ref_pixel_x
pixel_y = rotated_y * pixels_per_meter + ref_pixel_y
```

### Database Schema

Project model additions:

```python
class Project(models.Model):
    # ... existing fields ...
    
    # Cadastre layer settings
    cadastre_enabled = models.BooleanField(default=False)
    cadastre_opacity = models.FloatField(default=0.7)
    cadastre_color = models.CharField(max_length=7, default='#FF0000')
    cadastre_cache_timestamp = models.DateTimeField(null=True, blank=True)
```

### State Management

JavaScript state variables:

```javascript
let cadastreFeatures = [];          // GeoJSON features from API/file
let cadastreLayerGroup = null;      // Fabric.js Group object
let cadastreEnabled = false;        // Layer loaded/enabled
let cadastreOpacity = 0.7;          // 0-1
let cadastreColor = '#FF0000';      // Hex color
let cadastreVisible = true;         // Show/hide
```

### Layer Rendering

1. **Load Data**
   - Fetch from API or read from file
   - Receive GeoJSON FeatureCollection

2. **Create Polylines**
   - For each feature's geometry
   - Extract coordinate rings
   - Create fabric.Polyline for each ring
   - Apply opacity and color

3. **Group Objects**
   - Combine all polylines into fabric.Group
   - Set group properties (selectable, rotatable)
   - Add to canvas

4. **Position Layer**
   - Move to z-index 1 (behind sheets)
   - Render on canvas

### Event Handlers

```javascript
// Selection
canvas.on('selection:created', function(opt) {
    if (opt.selected[0].cadastreLayer) {
        selectCadastreLayer();
    }
});

// Movement (automatic via Fabric.js)
// Rotation (automatic via Fabric.js)

// Settings changes
function setCadastreOpacity(opacity) {
    // Update all polylines in group
    // Debounced save to server
}
```

### Performance Considerations

**Optimization strategies:**
- Cache API responses (1 hour)
- Limit search radius (500m default, 2000m max)
- Use fabric.Group for single-object manipulation
- Debounce settings saves (500ms delay)
- Layer z-ordering for efficient rendering

**Bottlenecks:**
- Large numbers of features (>1000)
- Complex geometries (many vertices)
- File upload size (>50MB)

**Recommendations:**
- Pre-clip data to area of interest
- Simplify geometries in QGIS
- Use visibility toggle when not needed

---

## FAQ

**Q: Why is the layer draggable instead of auto-aligned?**  
A: Engineering drawings often have slight rotations, scale variations, or registration issues. Manual alignment gives you precise control.

**Q: Does dragging the cadastre layer affect asset positions?**  
A: No, the cadastre layer is purely a visual overlay. Asset positions remain unchanged.

**Q: Can I save the layer position between sessions?**  
A: Not currently. This is planned for a future update.

**Q: What's the maximum file size for uploads?**  
A: No hard limit, but files over 50MB may be slow. Use QGIS to clip large datasets.

**Q: Can I use cadastre data from other states/countries?**  
A: Yes, as long as it's in GeoJSON format with WGS84 coordinates.

**Q: Why do I need a reference point?**  
A: The reference point anchors the coordinate transformation from lat/lon to pixel coordinates.

**Q: Can I have multiple cadastre layers?**  
A: Not currently. Only one layer per project.

**Q: Is the cadastre data updated in real-time?**  
A: No, API data is cached for 1 hour. Uploaded files are static.

---

## Version History

### v1.1 (February 17, 2026)
- ✅ Added GeoJSON file upload option
- ✅ Enhanced error messages with download suggestions
- ✅ Improved documentation
- ✅ Added file validation

### v1.0 (February 17, 2026)
- ✅ Initial implementation
- ✅ Queensland API integration
- ✅ Draggable layer group
- ✅ Opacity and color controls
- ✅ Coordinate transformation
- ✅ Settings persistence

---

## Support & Resources

### Documentation
- Full implementation guide (this document)
- API documentation: See endpoints section above
- QGIS tutorials: https://docs.qgis.org/

### Data Sources
- QLD Spatial Catalogue: https://qldspatial.information.qld.gov.au/catalogue/
- QLD Open Data: https://www.data.qld.gov.au/
- OpenStreetMap: https://www.openstreetmap.org/

### Tools
- GeoJSON validator: http://geojson.io/
- QGIS: https://qgis.org/
- GeoJSON Lint: https://geojsonlint.com/

### Contact
- GitHub Issues: [docuweaver/issues](https://github.com/jpmarshTMR/docuweaver/issues)
- Project Owner: jpmarshTMR

---

**Last Updated:** February 17, 2026  
**Feature Status:** ✅ Production Ready  
**Known Issues:** None
