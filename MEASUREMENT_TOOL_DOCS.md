# Modular Measurement Tool Documentation

## Overview

The measurement tool has been refactored into a modular, self-contained system (`measurement_tool.js`) that handles all measurement functionality independently from the main canvas editor. This keeps the 6k+ line `canvas_editor.js` clean while providing a complete, extensible measurement system.

## Key Features

### Single Line Measurements
- Click two points to measure the straight-line distance
- Automatically clears after the second point
- Useful for quick measurements between specific locations

### Chain Measurements  
- Click multiple points to create a chain of connected segments
- Displays distance for each segment and total chain distance
- **Middle-click ends the chain** - prevents unintended drawing when moving to save button
- Useful for measuring complex paths, perimeters, or routes

### Measurement Persistence
- Save measurements with custom names
- Toggle visibility of saved measurements
- Delete measurements you no longer need
- Measurements are stored on the server and persist across sessions

### Visual Feedback
- Point markers show where measurements start/end
- Dashed lines show measured segments
- Distance labels appear at the midpoint of each segment
- Preview line and label follow cursor until clicked
- Color-coded display (cyan by default)

## Installation

The tool is loaded in `editor.html` before `canvas_editor.js`:

```html
<script src="{% static 'js/measurement_tool.js' %}"></script>
<script src="{% static 'js/canvas_editor.js' %}"></script>
```

## Usage

### For Users

1. **Enter Measurement Mode**
   - Click the "Measure" button in the left toolbar or press the Measure tool
   
2. **Select Measurement Type**
   - Single: Two-point straight-line measurements
   - Chain: Multi-point path measurements

3. **Draw the Measurement**
   - Click to add points
   - Watch the distance update in real-time
   - In chain mode, middle-click to finish (won't draw to cursor)

4. **Save the Measurement**
   - Click the "💾 Save" button
   - Enter a name for the measurement
   - Measurement is saved to the database

5. **Manage Saved Measurements**
   - Check/uncheck to show/hide measurements
   - Click the eye icon to focus on a specific measurement
   - Click the × to delete a measurement

### For Developers

#### Initialize the Tool

```javascript
MeasurementTool.init(canvas, projectId);
```

**Parameters:**
- `canvas` (fabric.Canvas): The Fabric.js canvas instance
- `projectId` (number/string): The project ID for API calls

#### Start a New Measurement

```javascript
MeasurementTool.startMeasurement('single');  // or 'chain'
```

**Modes:**
- `'single'`: Two-point measurement, auto-clears after second point
- `'chain'`: Multi-point measurement, requires manual end via middle-click

#### Add a Point

```javascript
const success = MeasurementTool.addPoint(x, y);
```

**Returns:** `true` if point was added, `false` if distance too short

#### Handle Mouse Movement

```javascript
// Call this in mouse:move handler
const pointer = canvas.getPointer(opt.e);
MeasurementTool.handleMouseMove(pointer.x, pointer.y);
```

#### End a Chain Measurement

```javascript
MeasurementTool.endMeasurement();
```

This stops accepting new points but keeps the current measurement visible until cleared.

#### Clear Current Measurement

```javascript
MeasurementTool.clearCurrent();
```

Removes all overlays for the current measurement and resets state.

#### Save to Database

```javascript
await MeasurementTool.saveCurrent(name);
```

**Parameters:**
- `name` (string): Display name for the measurement

**Returns:** Promise<boolean> - `true` if save successful

#### Load Saved Measurements

```javascript
await MeasurementTool.loadSaved();
```

Fetches all saved measurements from the server and updates internal state.

#### Render Saved Measurements

```javascript
MeasurementTool.renderSaved();
```

Draws all visible saved measurements on the canvas.

#### Toggle Visibility

```javascript
await MeasurementTool.toggleVisibility(id, visible);
```

**Parameters:**
- `id` (number): Measurement ID
- `visible` (boolean): New visibility state

#### Delete Measurement

```javascript
await MeasurementTool.delete(id, name);
```

Prompts for confirmation and deletes the measurement.

## Getters & Utilities

### Get Current Measurement Data

```javascript
const points = MeasurementTool.getCurrentPoints();      // Array of {x, y}
const mode = MeasurementTool.getCurrentMode();          // 'single', 'chain', or null
const dist = MeasurementTool.getTotalDistance();        // {pixels, meters, calibrated}
const distStr = MeasurementTool.getTotalDistanceFormatted(); // "12.34 m" or "1234 px"
const saved = MeasurementTool.getSavedMeasurements();   // Array of saved measurements
```

### Configuration

```javascript
const config = MeasurementTool.getConfig();
```

Returns the current configuration object with color, size, and style settings.

## API Integration

The tool makes the following API calls:

### Load Measurements
```
GET /api/projects/{projectId}/measurement-sets/
```

### Save Measurement
```
POST /api/projects/{projectId}/measurement-sets/
Body: {
    name: string,
    measurement_type: 'single' | 'chain',
    points: [{x, y}, ...],
    color: string,
    total_distance_pixels: number,
    total_distance_meters: number | null
}
```

### Toggle Visibility
```
PATCH /api/measurement-sets/{id}/toggle-visibility/
Body: { visible: boolean }
```

### Delete Measurement
```
DELETE /api/measurement-sets/{id}/
```

## Distance Calculation

Measurements automatically detect whether scale calibration is available:

- **Calibrated Projects**: Distances shown in meters (m), kilometers (km), or centimeters (cm)
- **Uncalibrated Projects**: Distances shown in pixels (px)

The tool uses `PROJECT_DATA.pixels_per_meter` and `PROJECT_DATA.scale_calibrated` from the global scope.

## Configuration

Edit the `config` object inside `measurement_tool.js` to customize appearance:

```javascript
const config = {
    markerRadius: 4,
    markerColor: '#00bcd4',
    markerStroke: '#ffffff',
    lineColor: '#00bcd4',
    lineStrokeWidth: 1.5,
    previewLineOpacity: 0.6,
    labelFontSize: 12,
    fontFamily: 'monospace',
    minSegmentLength: 2,  // Prevent accidental clicks
    // ... more options
};
```

## Canvas Integration

The tool integrates with the main canvas editor:

- Measurements are always rendered on top (z-index managed)
- Tool is initialized in `initCanvas()` after canvas creation
- Measurement mode triggers via `setMode('measure')`
- Middle-click during chain mode ends the measurement instead of panning
- Save/delete operations are wrapped in `canvas_editor.js` for backward compatibility

## Events & Hooks

The tool listens for these canvas events:

- `mouse:down` - Detect point clicks
- `mouse:move` - Update preview line and label
- `mouse:up` - No special handling needed

## Performance Considerations

- Point markers and lines are added as Fabric.js objects
- Large numbers of saved measurements are rendered incrementally
- Preview lines are removed when measurement ends to reduce overdraw
- Saved measurements are sent to back to ensure sheets are visible

## Troubleshooting

### Measurements not showing
- Verify `MeasurementTool.init()` was called
- Check browser console for JavaScript errors
- Ensure Fabric.js is loaded before measurement_tool.js

### Middle-click not ending chain
- Make sure you're in 'chain' mode (check the radio button)
- Verify canvas is in 'measure' mode
- Check that middle-click handler is properly integrated

### Measurements disappearing when zooming
- This is expected - measurements are in canvas coordinates
- They'll reappear when canvas re-renders
- Use saved measurements for persistent display

### Saved measurements not loading
- Check network tab for API errors
- Verify project ID is correct
- Ensure database migration for MeasurementSet model was applied

## Future Enhancements

Potential improvements for the measurement system:

1. **Measurement Groups** - Organize related measurements
2. **Colored Labels** - Custom colors per measurement type
3. **Annotations** - Add text notes to measurements
4. **Measurement Templates** - Save presets for common measurements
5. **Export** - Save measurements to CSV or PDF
6. **Undo/Redo** - Full undo history for measurement operations
7. **Measurement Snapping** - Snap to sheet corners or other objects
