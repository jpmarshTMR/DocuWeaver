# Measurement Tool Bug Fixes

## Issues Fixed

### 1. Single Mode Not Auto-Clearing
**Problem**: Single mode was behaving like chain mode - allowing infinite points instead of clearing after 2 points.

**Solution**: Updated `addPoint()` function to automatically clear and restart measurement after 2 points in single mode:
```javascript
if (currentMode === 'single' && currentPoints.length >= 2) {
    console.log('Single mode: already has 2 points, auto-clearing for next measurement');
    clearCurrent();
    startMeasurement('single');
}
```

Now when you draw a single line measurement:
1. Click first point
2. Click second point → Shows distance
3. Automatically clears and is ready for next single measurement
4. This allows you to quickly draw multiple single lines one after another

### 2. Save Failure - Null Mode
**Problem**: When saving a measurement, `currentMode` could be `null` (especially if you clicked outside the tool after drawing), causing the API to fail.

**Solution**: Store the measurement mode before save and default to 'single' if mode is null:
```javascript
const mode = currentMode || 'single'; // Default to 'single' if mode is null
```

### 3. Poor Error Messages
**Problem**: Save failures gave generic "Failed to save measurement" errors without details about what went wrong.

**Solution**: Added detailed error logging:
- Logs the measurement data being sent
- Logs HTTP response status
- Tries to parse API error messages
- Falls back to HTTP status if no JSON error
- Console shows all details for debugging

## How to Test

### Test Single Mode
1. Click "Measure" button, select "Single" radio button
2. Click point 1 on canvas
3. Click point 2 on canvas
4. Should automatically clear
5. Click new point 1
6. Click new point 2
7. Should automatically clear again
8. This allows rapid successive single measurements

### Test Saving
1. Draw a measurement (either single or chain)
2. Click "💾 Save" button
3. Enter a name like "Test Measurement"
4. Check browser console (F12 → Console tab)
5. You should see logs like:
   ```
   Saving measurement: {name: "Test Measurement", measurement_type: "single", points: [...], ...}
   Save response status: 201
   Measurement saved successfully: {id: 123, ...}
   ```

### Test Chain Mode
1. Select "Chain" radio button
2. Click multiple points to create a path
3. Move mouse away to see preview
4. Right-click to finish OR middle-click to end the chain
5. Total distance and segment distances should show
6. Can save the chain measurement

## Debugging Save Errors

If saving still fails:

1. **Open Browser DevTools** (F12 or right-click → Inspect)
2. **Go to Console Tab**
3. **Try to save a measurement**
4. **Look for error messages** - they'll show exactly what the API returned
5. **Check Network Tab** to see the actual HTTP request/response:
   - URL: `/api/projects/{projectId}/measurement-sets/`
   - Method: POST
   - Status should be 201 (Created) for success

Common errors:
- **400 Bad Request**: Invalid data format, check console logs
- **401 Unauthorized**: CSRF token might be missing
- **403 Forbidden**: Permission issue
- **404 Not Found**: Wrong endpoint or projectId

## Code Changes Summary

### `measurement_tool.js`
- Modified `addPoint()` to auto-clear after 2 points in single mode
- Modified `saveCurrent()` to store mode before save and add detailed logging
- Added error response parsing with fallbacks

### `canvas_editor.js`
- Enhanced `saveMeasurementPrompt()` with logging for debugging

## Next Steps if Still Having Issues

1. **Check the console logs** when you try to save
2. **Check the Network tab** to see the API response
3. **Verify the measurement data** is correct (points array, mode, etc.)
4. **Test with a simple measurement** (just 2 points) to isolate the issue
5. **Check if all required fields** are present in the API request

The detailed error logging should now tell you exactly what went wrong!
