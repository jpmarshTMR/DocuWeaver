/**
 * Canvas Editor for PDF Alignment and Asset Overlay
 * Uses Fabric.js for canvas manipulation
 */

// IMMEDIATE FIX: Patch CanvasRenderingContext2D to fix Fabric.js 'alphabetical' textBaseline bug
// This must run BEFORE any Fabric.js code to prevent console spam
(function() {
    const originalTextBaselineSetter = Object.getOwnPropertyDescriptor(
        CanvasRenderingContext2D.prototype, 'textBaseline'
    );
    if (originalTextBaselineSetter && originalTextBaselineSetter.set) {
        Object.defineProperty(CanvasRenderingContext2D.prototype, 'textBaseline', {
            set: function(value) {
                // Convert deprecated 'alphabetical' to valid 'alphabetic'
                if (value === 'alphabetical') {
                    value = 'alphabetic';
                }
                originalTextBaselineSetter.set.call(this, value);
            },
            get: originalTextBaselineSetter.get
        });
    }
})();

// Get CSRF token from cookies (required for Django)
function getCSRFToken() {
    const name = 'csrftoken';
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

// Import/Add dropdown functions
function toggleImportDropdown(btn) {
    const menu = document.getElementById('import-dropdown-menu');
    const isOpen = menu.classList.contains('open');
    
    // Close the dropdown
    if (isOpen) {
        closeImportDropdown();
    } else {
        // Open the dropdown
        btn.classList.add('open');
        menu.classList.add('open');
        
        // Close when clicking outside
        setTimeout(() => {
            document.addEventListener('click', closeImportDropdownOnClickOutside);
        }, 10);
    }
}

function closeImportDropdown() {
    const menu = document.getElementById('import-dropdown-menu');
    const btn = document.querySelector('.import-dropdown-btn');
    if (menu) menu.classList.remove('open');
    if (btn) btn.classList.remove('open');
    document.removeEventListener('click', closeImportDropdownOnClickOutside);
}

function closeImportDropdownOnClickOutside(e) {
    const wrapper = document.querySelector('.import-dropdown-wrapper');
    if (wrapper && !wrapper.contains(e.target)) {
        closeImportDropdown();
    }
}

// State
let canvas = null;
let currentMode = 'pan';
let selectedSheet = null;
let selectedAsset = null;
let sheets = [];
let assets = [];
let links = [];  // Link layer data
let linksVisible = true;  // Link layer visibility
let calibrationPoints = [];

// Crop/Cut tool state
let cropRect = null;
let cropStart = null;
let isCropping = false;
let sheetCutData = {};  // Store cut data per sheet for flipping
let cutStatsLabel = null;  // Fabric.Text showing angle/length while drawing
let showUncutSheetId = null;  // Sheet ID currently showing uncut, or null

// Viewport rotation state
let viewportRotation = 0;  // Will be loaded from PROJECT_DATA
let currentZoomLevel = 1;  // Track zoom independently (canvas.getZoom() breaks with rotation)

// Asset layer calibration state
let assetRotationDeg = 0;       // Independent asset layer rotation (degrees)
let refAssetId = '';             // Reference asset identifier
let refPixelX = 0, refPixelY = 0; // Where reference was placed on canvas
let verifyRefMarker = null;      // Canvas marker for reference point

// Measurement tool state
let measurePoints = [];          // Array of {x, y} canvas-coord points
let measureMode = 'single';      // 'single' or 'chain'
let measureOverlays = [];        // All fabric objects for batch cleanup
let measurePreviewLine = null;   // Live dashed line from last point to cursor
let measurePreviewLabel = null;  // Live distance label near cursor

// PDF inversion state
let isPdfInverted = false;

// Layer group and measurement set state
let assetGroups = [];  // Asset layer groups
let linkGroups = [];   // Link layer groups
let sheetGroups = [];  // Sheet layer groups
let measurementGroups = [];  // Measurement layer groups

// OpenStreetMap layer state
let osmTiles = [];       // Array of fabric.Image objects for OSM tiles
let osmEnabled = false;  // Toggle for OSM layer visibility
let osmOpacity = 0.7;    // OSM layer opacity
let osmZIndex = 0;       // OSM layer z-index
let osmRefreshTimeout = null; // Timeout for debounced OSM refresh
let osmDarkMode = false; // OSM dark mode state
let osmCurrentZoom = null; // Track current zoom to detect zoom changes
let osmLoadedTiles = new Map(); // Map of tile keys to { tile, zoom }
let osmTileCache = {};   // In-memory tile cache: { 'key': 'data-url' }
let osmTileCacheStats = {
    maxSize: 20 * 1024 * 1024, // 20 MB max cache size
    currentSize: 0,             // Current cache size in bytes
    hits: 0,                    // Cache hit count
    misses: 0,                  // Cache miss count
    tilesToDelete: []           // Queue for tiles to delete
};
let measurementSets = [];  // Saved measurement sets
let groupVisibility = {};  // { groupId: boolean } visibility cache
let draggedItem = null;  // For drag-and-drop between groups

// Undo system
const undoStack = [];
const MAX_UNDO_STEPS = 50;

/**
 * Save state for undo functionality
 * @param {string} actionType - Type of action: 'move', 'rotate', 'cut', 'clearCut'
 * @param {object} data - State data to save
 */
function saveUndoState(actionType, data) {
    undoStack.push({
        type: actionType,
        timestamp: Date.now(),
        data: JSON.parse(JSON.stringify(data))  // Deep clone
    });

    // Limit stack size
    if (undoStack.length > MAX_UNDO_STEPS) {
        undoStack.shift();
    }

    console.log('Undo state saved:', actionType, data);
}

/**
 * Undo the last action
 */
async function undo() {
    if (undoStack.length === 0) {
        console.log('Nothing to undo');
        return;
    }

    const lastAction = undoStack.pop();
    console.log('Undoing action:', lastAction.type, lastAction.data);

    switch (lastAction.type) {
        case 'transform':
            await undoTransform(lastAction.data);
            break;
        case 'cut':
            await undoCut(lastAction.data);
            break;
        case 'clearCut':
            await undoClearCut(lastAction.data);
            break;
    }
}

/**
 * Undo a sheet transform action (combined move + rotate)
 */
async function undoTransform(data) {
    const { sheetId, previousX, previousY, previousRotation } = data;

    // Find sheet object on canvas
    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        // Restore canvas position and rotation
        sheetObj.set({
            left: previousX,
            top: previousY,
            angle: previousRotation
        });
        sheetObj.setCoords();
        canvas.renderAll();

        // Update local data
        const index = sheets.findIndex(s => s.id === sheetId);
        if (index >= 0) {
            sheets[index].offset_x = previousX;
            sheets[index].offset_y = previousY;
            sheets[index].rotation = previousRotation;
        }

        // Update properties panel if selected
        if (selectedSheet && selectedSheet.id === sheetId) {
            document.getElementById('sheet-offset-x').value = previousX;
            document.getElementById('sheet-offset-y').value = previousY;
            document.getElementById('sheet-rotation').value = previousRotation.toFixed(1);
            selectedSheet.offset_x = previousX;
            selectedSheet.offset_y = previousY;
            selectedSheet.rotation = previousRotation;
        }

        // Save to server (both position and rotation)
        await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                offset_x: previousX,
                offset_y: previousY,
                rotation: previousRotation
            })
        });
    }
}

/**
 * Undo a cut action (remove the cut)
 */
async function undoCut(data) {
    const { sheetId, previousCutData } = data;

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        if (previousCutData && previousCutData.length > 0) {
            sheetCutData[sheetId] = previousCutData;
            applyAllCuts(sheetObj, previousCutData);
        } else {
            sheetObj.clipPath = null;
            sheetObj._clipPolygon = null;
            if (sheetObj._originalRender) {
                sheetObj._render = sheetObj._originalRender;
                delete sheetObj._originalRender;
            }
            delete sheetCutData[sheetId];
            sheetObj.objectCaching = true;
            sheetObj.dirty = true;
            canvas.renderAll();
        }

        await saveCutData(sheetId, previousCutData || []);
    }
}

/**
 * Undo a clear cut action (restore the cut)
 */
async function undoClearCut(data) {
    const { sheetId, cutData } = data;

    if (!cutData || cutData.length === 0) return;

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );

    if (sheetObj) {
        sheetCutData[sheetId] = cutData;
        applyAllCuts(sheetObj, cutData);
        await saveCutData(sheetId, cutData);
    }
}

// Initialize canvas
document.addEventListener('DOMContentLoaded', function() {
    initCanvas();
    
    // Initialize MeasurementTool
    MeasurementTool.init(canvas, PROJECT_ID);
    
    // Try to restore viewport state IMMEDIATELY before loading data
    // This provides a faster perceived restoration
    const viewportRestored = restoreViewportState();
    
    loadProjectData().then(() => {
        // Only restore viewport again if it wasn't already restored
        if (!viewportRestored) {
            setTimeout(() => {
                restoreViewportState();
            }, 100);
        }
        
        // Hook up view state saving for pan/zoom tracking
        hookViewStateSaving();
    });

    // Initialize viewport rotation from project data
    if (PROJECT_DATA.canvas_rotation) {
        viewportRotation = PROJECT_DATA.canvas_rotation;
        // Apply rotation after canvas is ready
        setTimeout(() => {
            applyViewportRotation();
            updateRotationDisplay();
        }, 100);
    }

    // Initialize asset calibration from project data
    assetRotationDeg = PROJECT_DATA.asset_rotation || 0;
    refAssetId = PROJECT_DATA.ref_asset_id || '';
    refPixelX = PROJECT_DATA.ref_pixel_x || 0;
    refPixelY = PROJECT_DATA.ref_pixel_y || 0;
    document.getElementById('asset-rotation-slider').value = assetRotationDeg;
    document.getElementById('asset-rotation-input').value = assetRotationDeg;

    // Initialize theme state - PDF inversion is tied to dark mode
    var currentTheme = document.documentElement.getAttribute('data-theme') || 
                       localStorage.getItem('docuweaver-theme') || 'light';
    isPdfInverted = (currentTheme === 'dark');
    osmDarkMode = (currentTheme === 'dark'); // Sync OSM dark mode
    applyCanvasTheme();
    
    window.addEventListener('themechange', function(e) {
        applyCanvasTheme();
        
        // Update OSM dark mode and refresh tiles if OSM is enabled
        const newTheme = e.detail.theme;
        const newOsmDarkMode = (newTheme === 'dark');
        
        if (newOsmDarkMode !== osmDarkMode) {
            osmDarkMode = newOsmDarkMode;
            console.log(`OSM dark mode: ${osmDarkMode ? 'ON' : 'OFF'}`);
            
            // Refresh OSM tiles if layer is enabled
            if (osmEnabled) {
                console.log('Refreshing OSM tiles for theme change');
                // For theme changes, clear tiles so new ones load with new tile server
                clearOSMLayer();
                osmCurrentZoom = null; // Reset zoom tracker to force re-render
                renderOSMLayer();
            }
        }
    });
});

function initCanvas() {
    const container = document.getElementById('canvas-container');
    const containerRect = container.getBoundingClientRect();

    // Create canvas element
    const canvasEl = document.createElement('canvas');
    canvasEl.id = 'main-canvas';
    container.appendChild(canvasEl);

    // Initialize Fabric canvas
    canvas = new fabric.Canvas('main-canvas', {
        width: containerRect.width,
        height: containerRect.height,
        backgroundColor: '#e0e0e0',
        selection: false
    });

    // Force Canvas2D filter backend instead of WebGL.
    // The WebGL backend has a tileSize of 2048px which can cause images
    // larger than that to render incorrectly after filter application.
    fabric.filterBackend = new fabric.Canvas2dFilterBackend();

    // CRITICAL FIX: Smart viewport culling that works correctly with rotation
    // Fabric.js default culling breaks during rotation due to incorrect bounds calculation
    // We override with a rotation-aware version that adds a generous buffer
    
    // Store original isOnScreen method
    const originalIsOnScreen = fabric.Object.prototype.isOnScreen;
    
    fabric.Object.prototype.isOnScreen = function(calculateCoords) {
        // Always render sheets (they're the main content)
        if (this.sheetData) {
            return true;
        }
        
        // Always render OSM tiles (they're managed separately with viewport-aware loading)
        if (this.isOSMTile) {
            return true;
        }
        
        // Always render links (they can span large areas and are important)
        if (this.isLinkObject) {
            return true;
        }
        
        // Always render measurements (both active and saved)
        if (this.isMeasurement || this.isMeasurementGroup || this.isSavedMeasurement) {
            return true;
        }
        
        // For other objects (assets), use smart culling
        // Get object bounding rect
        const objBounds = this.getBoundingRect(true, true);
        if (!objBounds) return true;
        
        // Get canvas dimensions with a generous buffer (50% of canvas size on each side)
        // This ensures smooth scrolling and accounts for rotation
        const canvasEl = this.canvas;
        if (!canvasEl) return true;
        
        const bufferX = canvasEl.width * 0.5;
        const bufferY = canvasEl.height * 0.5;
        
        // Expanded viewport bounds
        const viewportLeft = -bufferX;
        const viewportTop = -bufferY;
        const viewportRight = canvasEl.width + bufferX;
        const viewportBottom = canvasEl.height + bufferY;
        
        // Check if object overlaps expanded viewport
        const objLeft = objBounds.left;
        const objTop = objBounds.top;
        const objRight = objBounds.left + objBounds.width;
        const objBottom = objBounds.top + objBounds.height;
        
        // Simple AABB intersection test
        const isVisible = !(objRight < viewportLeft || 
                           objLeft > viewportRight || 
                           objBottom < viewportTop || 
                           objTop > viewportBottom);
        
        return isVisible;
    };

    // Override getZoom: Fabric.js returns vpt[0] which is cos(angle)*zoom,
    // collapsing to ~0 at 90° rotation. Return our tracked zoom instead.
    canvas.getZoom = function() {
        return currentZoomLevel;
    };

    // Setup event handlers
    setupCanvasEvents();
    setupKeyboardShortcuts();

    // Handle window resize
    window.addEventListener('resize', function() {
        const rect = container.getBoundingClientRect();
        canvas.setDimensions({ width: rect.width, height: rect.height });
        canvas.renderAll();
    });
}

function setupCanvasEvents() {
    let isPanning = false;
    let isMiddleClickPanning = false;
    let lastPosX, lastPosY;

    // Track initial state for undo when interaction starts
    let interactionStartState = null;

    canvas.on('mouse:down', function(opt) {
        const evt = opt.e;
        console.log('mouse:down event, currentMode:', currentMode, 'button:', evt.button);

        // Capture state at the beginning of a transformation for undo
        const target = opt.target;
        if (target && target.sheetData && currentMode === 'select') {
            interactionStartState = {
                sheetId: target.sheetData.id,
                left: target.left,
                top: target.top,
                angle: target.angle
            };
        }

        // Middle click (button 1) - ends chain measurement or pans
        if (evt.button === 1) {
            evt.preventDefault();
            if (currentMode === 'measure' && MeasurementTool.getCurrentMode() === 'chain') {
                // End the chain measurement when middle-clicking
                MeasurementTool.endMeasurement();
                console.log('Chain measurement ended via middle-click');
            } else {
                // Otherwise, start middle-click panning
                isMiddleClickPanning = true;
                lastPosX = evt.clientX;
                lastPosY = evt.clientY;
                canvas.defaultCursor = 'grabbing';
                console.log('Middle-click panning started');
            }
            return;
        }

        // Left click (button 0) pans only in pan mode
        if (currentMode === 'pan' && evt.button === 0) {
            isPanning = true;
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            canvas.defaultCursor = 'grabbing';
            console.log('Pan mode panning started');
        } else if (currentMode === 'calibrate') {
            handleCalibrationClick(opt);
        } else if (currentMode === 'origin') {
            handleOriginClick(opt);
        } else if (currentMode === 'crop') {
            handleCropClick(opt);
        } else if (currentMode === 'split') {
            handleSplitClick(opt);
        } else if (currentMode === 'verify-asset') {
            handleVerifyClick(opt);
        } else if (currentMode === 'measure') {
            handleMeasureClick(opt);
        }
    });

    canvas.on('mouse:move', function(opt) {
        updateCursorPosition(opt);

        // Handle pan mode left-click panning
        if (isPanning && currentMode === 'pan') {
            const evt = opt.e;
            const vpt = canvas.viewportTransform;
            vpt[4] += evt.clientX - lastPosX;
            vpt[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            debouncedSaveViewportState();
        }

        // Handle middle-click panning (any mode)
        if (isMiddleClickPanning) {
            const evt = opt.e;
            const vpt = canvas.viewportTransform;
            vpt[4] += evt.clientX - lastPosX;
            vpt[5] += evt.clientY - lastPosY;
            canvas.requestRenderAll();
            lastPosX = evt.clientX;
            lastPosY = evt.clientY;
            debouncedSaveViewportState();
        }

        // Handle crop drag
        if (currentMode === 'crop') {
            handleCropMove(opt);
        }

        // Handle split drag (same visual as crop)
        if (currentMode === 'split') {
            handleSplitMove(opt);
        }

        // Handle measurement live preview
        if (currentMode === 'measure' && MeasurementTool.getCurrentMode()) {
            const pointer = canvas.getPointer(opt.e);
            MeasurementTool.handleMouseMove(pointer.x, pointer.y);
        }
    });

    canvas.on('mouse:up', function(opt) {
        isPanning = false;
        isMiddleClickPanning = false;
        
        if (currentMode === 'pan') {
            canvas.defaultCursor = 'grab';
        }

        // Handle crop end
        if (currentMode === 'crop' && isCropping) {
            handleCropEnd(opt);
        }

        // Handle split end
        if (currentMode === 'split' && isSplitting) {
            handleSplitEnd(opt);
        }
        
        // Refresh OSM tiles after panning
        debouncedRefreshOSM();
    });

    // Right-click to finish multi-line measurement
    canvas.upperCanvasEl.addEventListener('contextmenu', function(e) {
        e.preventDefault();
        if (currentMode === 'measure' && measureMode === 'multi' && measurePoints.length >= 2) {
            // Finish the measurement - remove preview and keep what we have
            removeMeasurePreview();
            canvas.renderAll();
        }
    });

    canvas.on('mouse:wheel', function(opt) {
        const delta = opt.e.deltaY;
        const oldZoom = currentZoomLevel;
        let zoom = oldZoom;
        zoom *= 0.999 ** delta;
        if (zoom > 5) zoom = 5;
        if (zoom < 0.1) zoom = 0.1;
        currentZoomLevel = zoom;

        // Zoom to cursor point while preserving rotation.
        // Use full inverse matrix to convert screen -> canvas (handles rotation).
        const point = { x: opt.e.offsetX, y: opt.e.offsetY };
        const vpt = canvas.viewportTransform.slice();
        const invMatrix = fabric.util.invertTransform(vpt);
        const canvasPt = fabric.util.transformPoint(new fabric.Point(point.x, point.y), invMatrix);

        // Build new viewport transform with updated zoom
        const angleRad = viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);

        vpt[0] = cos * zoom;
        vpt[1] = sin * zoom;
        vpt[2] = -sin * zoom;
        vpt[3] = cos * zoom;

        // Adjust pan so the canvas point under the cursor stays at the same screen position
        const newScreenPt = fabric.util.transformPoint(canvasPt, vpt);
        vpt[4] += point.x - newScreenPt.x;
        vpt[5] += point.y - newScreenPt.y;

        canvas.setViewportTransform(vpt);
        canvas.forEachObject(function(obj) { obj.setCoords(); });
        opt.e.preventDefault();
        opt.e.stopPropagation();

        updateZoomDisplay();
        debouncedSaveViewportState();
        debouncedRefreshOSM(); // Refresh OSM tiles on zoom
    });

    canvas.on('object:moving', function(opt) {
        const obj = opt.target;
        if (obj.assetData) {
            // Asset is being dragged
            updateAssetPositionFromCanvas(obj);
        } else if (obj.sheetData) {
            // Sheet is being dragged
            updateSheetPositionFromCanvas(obj);
        }
    });

    // Use object:modified which fires after any transformation (move, rotate, scale)
    canvas.on('object:modified', function(opt) {
        const obj = opt.target;
        if (obj.sheetData) {
            // Save undo state for the transformation (single combined state)
            if (interactionStartState && interactionStartState.sheetId === obj.sheetData.id) {
                const positionChanged = interactionStartState.left !== obj.left || interactionStartState.top !== obj.top;
                const rotationChanged = interactionStartState.angle !== obj.angle;

                // Save a single combined transform state if anything changed
                if (positionChanged || rotationChanged) {
                    saveUndoState('transform', {
                        sheetId: obj.sheetData.id,
                        previousX: interactionStartState.left,
                        previousY: interactionStartState.top,
                        previousRotation: interactionStartState.angle
                    });
                }
                // Clear the interaction state
                interactionStartState = null;
            }

            // Check if rotation changed and update
            updateSheetRotationFromCanvas(obj);
            // Also save position in case it was moved
            updateSheetPositionFromCanvas(obj);
        }
    });

    // Also update during rotation for live feedback in properties panel
    canvas.on('object:rotating', function(opt) {
        const obj = opt.target;
        if (obj.sheetData && selectedSheet && selectedSheet.id === obj.sheetData.id) {
            // Live update the rotation field while rotating
            document.getElementById('sheet-rotation').value = obj.angle.toFixed(1);
        }
    });

    // Let Fabric.js selection events be the single source of truth
    // for which object is selected (avoids conflicts with mouse:down).
    canvas.on('selection:created', function(opt) {
        const obj = opt.selected[0];
        if (obj && obj.sheetData) {
            selectSheet(obj.sheetData.id);
        } else if (obj && obj.assetData) {
            selectAsset(obj.assetData.id);
        } else if (obj && obj.isSavedMeasurement) {
            // Show measurement name in status or highlight in sidebar
            selectMeasurement(obj.measurementSetId);
        }
    });

    canvas.on('selection:updated', function(opt) {
        const obj = opt.selected[0];
        if (obj && obj.sheetData) {
            selectSheet(obj.sheetData.id);
        } else if (obj && obj.assetData) {
            selectAsset(obj.assetData.id);
        } else if (obj && obj.isSavedMeasurement) {
            selectMeasurement(obj.measurementSetId);
        }
    });

    canvas.on('selection:cleared', function() {
        clearSelection();
    });
}

// Track currently selected measurement
let selectedMeasurementId = null;

function selectMeasurement(msId) {
    selectedMeasurementId = msId;
    const ms = MeasurementTool ? MeasurementTool.getSavedMeasurements().find(m => m.id === msId) : null;
    if (ms && typeof showToast === 'function') {
        showToast(`Selected: ${ms.name || 'Measurement'} - Press Delete to remove`, 'info');
    }
    // Highlight in sidebar if needed
    highlightMeasurementInSidebar(msId);
}

function highlightMeasurementInSidebar(msId) {
    // Remove existing highlights
    document.querySelectorAll('.folder-item-entry.selected-measurement').forEach(el => {
        el.classList.remove('selected-measurement');
    });
    // Add highlight to matching measurement
    const itemEl = document.querySelector(`.folder-item-entry[data-item-id="${msId}"][data-item-type="measurement"]`);
    if (itemEl) {
        itemEl.classList.add('selected-measurement');
        itemEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        // Handle Ctrl+Z for undo
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }

        switch(e.key) {
            case '1':
                setMode('pan');
                break;
            case '2':
                setMode('select');
                break;
            case '3':
                setMode('crop');
                break;
            case '4':
                setMode('calibrate');
                break;
            case '5':
                setMode('origin');
                break;
            case 'Escape':
                clearSelection();
                selectedMeasurementId = null;
                break;
            case 'Delete':
            case 'Backspace':
                // Handle delete for selected measurement
                if (selectedMeasurementId && MeasurementTool) {
                    e.preventDefault();
                    deleteSelectedMeasurement();
                }
                break;
            case '+':
            case '=':
                zoomIn();
                break;
            case '-':
                zoomOut();
                break;
        }
    });
}

/**
 * Delete the currently selected measurement
 */
async function deleteSelectedMeasurement() {
    if (!selectedMeasurementId) return;
    
    const ms = MeasurementTool ? MeasurementTool.getSavedMeasurements().find(m => m.id === selectedMeasurementId) : null;
    if (!ms) return;
    
    // Pass name to MeasurementTool.delete() which handles the confirmation dialog
    const success = await MeasurementTool.delete(selectedMeasurementId, ms.name || 'Unnamed');
    if (success) {
        selectedMeasurementId = null;
        canvas.discardActiveObject();
        canvas.renderAll();
        renderLayerGroupsUI();
    }
}

// Mode Management
function setMode(mode) {
    console.log('setMode called with:', mode, '(previous mode:', currentMode + ')');

    // Clean up measurement overlays when leaving measure mode
    if (currentMode === 'measure' && mode !== 'measure') {
        clearMeasurements();
    }

    currentMode = mode;

    // Toggle measure panel visibility (now in its own sidebar section)
    const measureSection = document.getElementById('measure-section');
    if (measureSection) {
        measureSection.style.display = (mode === 'measure') ? 'block' : 'none';
    }
    
    // Move measurement layer section to top when in measure mode for visibility
    if (mode === 'measure') {
        moveMeasurementSectionToTop();
    }

    // Auto-deselect when leaving select mode
    if (mode !== 'select') {
        clearSelection();
    }

    // Update button states (both sidebar and floating toolbar)
    document.querySelectorAll('.tool-btn[data-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.querySelectorAll('.ftool-btn[data-mode]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // Update cursor and object selectability
    const isSelectMode = (mode === 'select');

    switch(mode) {
        case 'pan':
            canvas.defaultCursor = 'grab';
            canvas.selection = false;
            break;
        case 'select':
            canvas.defaultCursor = 'default';
            canvas.selection = true;
            break;
        case 'crop':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;  // Prevent box selection
            break;
        case 'split':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;  // Prevent box selection
            break;
        case 'calibrate':
            canvas.defaultCursor = 'crosshair';
            calibrationPoints = [];
            break;
        case 'origin':
            canvas.defaultCursor = 'crosshair';
            break;
        case 'verify-asset':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;
            break;
        case 'measure':
            canvas.defaultCursor = 'crosshair';
            canvas.selection = false;
            break;
    }

    // Update selectability of all sheet objects
    // Sheets are selectable only in select mode
    // Sheets must be evented in crop/split mode to detect clicks for cut lines
    const isCropOrSplitMode = (mode === 'crop' || mode === 'split');
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) {
            obj.selectable = isSelectMode;
            obj.evented = isSelectMode || isCropOrSplitMode;
            obj.hoverCursor = isCropOrSplitMode ? 'crosshair' : 'move';
        }
        // Measurements should only be selectable/evented in select mode
        if (obj.isSavedMeasurement) {
            obj.selectable = isSelectMode;
            obj.evented = isSelectMode;
        }
    });
    canvas.renderAll();

    document.getElementById('current-mode').textContent = mode.charAt(0).toUpperCase() + mode.slice(1);
}

// ==================== Notification System ====================

function showToast(message, type = 'info', duration = 3000) {
    const toast = document.getElementById('notification-toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `notification-toast show ${type}`;
    
    // Auto-hide after duration
    setTimeout(() => {
        toast.classList.remove('show');
    }, duration);
}

// ==================== Data Loading ====================

// Data Loading
async function loadProjectData() {
    try {
        // Load ALL data in parallel FIRST (including layer groups)
        // This ensures group structure is known before rendering anything
        const [sheetsResponse, assetsResponse, linksResponse, assetGroupsResponse, linkGroupsResponse, sheetGroupsResponse, measurementGroupsResponse] = await Promise.all([
            fetch(`/api/projects/${PROJECT_ID}/sheets/`),
            fetch(`/api/projects/${PROJECT_ID}/assets/`),
            fetch(`/api/projects/${PROJECT_ID}/links/`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=asset`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=link`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=sheet`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=measurement`)
        ]);

        // Parse all responses
        if (sheetsResponse.ok) {
            sheets = await sheetsResponse.json();
        }
        if (assetsResponse.ok) {
            assets = await assetsResponse.json();
        }
        if (linksResponse.ok) {
            links = await linksResponse.json();
        }
        
        // Parse layer groups
        if (assetGroupsResponse.ok) {
            assetGroups = await assetGroupsResponse.json();
        }
        if (linkGroupsResponse.ok) {
            linkGroups = await linkGroupsResponse.json();
        }
        if (sheetGroupsResponse.ok) {
            sheetGroups = await sheetGroupsResponse.json();
        }
        if (measurementGroupsResponse.ok) {
            measurementGroups = await measurementGroupsResponse.json();
        }

        // Initialize visibility from loaded group data
        [...assetGroups, ...linkGroups, ...sheetGroups, ...measurementGroups].forEach(g => {
            groupVisibility[g.id] = g.visible;
        });

        // NOW render everything with group structure already in place
        renderSheetLayers();
        renderAssetList();
        renderSheetsOnCanvas();
        renderAssetsOnCanvas();
        renderLinksOnCanvas();
        renderLinkList();
        renderImportBatches();
        renderLinkImportBatches();
        
        // Render layer groups UI (groups already loaded above)
        renderLayerGroupsUI();
        
        // Load and render measurement sets with groups
        await MeasurementTool.loadSaved();
        MeasurementTool.renderSaved();
        await renderMeasurementGroupList();
        
        // Store measurement groups in PROJECT_DATA for modal access
        PROJECT_DATA.measurementGroups = measurementGroups;

        // Initialize OSM layer settings from project data
        osmEnabled = PROJECT_DATA.osm_enabled || false;
        osmOpacity = PROJECT_DATA.osm_opacity || 0.7;
        osmZIndex = PROJECT_DATA.osm_z_index || 0;
        
        // Render OSM layer if enabled, but delay it to allow viewport restoration
        // This ensures OSM renders in the correct viewport location
        if (osmEnabled) {
            setTimeout(() => {
                console.log('Rendering OSM layer after viewport stabilization');
                renderOSMLayer();
            }, 1000); // 1 second delay allows viewport restoration to complete
        }
        
        // Update OSM toggle button state
        const osmBtn = document.getElementById('osm-toggle-btn');
        if (osmBtn) {
            osmBtn.style.background = osmEnabled ? 'var(--bg-tool-btn-active)' : 'var(--bg-tool-btn)';
            osmBtn.style.color = osmEnabled ? '#ffffff' : 'inherit';
        }

        // Restore reference point marker if configured
        if (refAssetId && (refPixelX !== 0 || refPixelY !== 0)) {
            drawVerifyRefMarker(refPixelX, refPixelY);
        }

    } catch (error) {
        console.error('Error loading project data:', error);
    }
}

function renderSheetLayers() {
    // Now uses folder structure
    renderSheetGroupList();
}

function renderAssetList() {
    // Assets are now rendered inside folders by renderAssetGroupList()
    // This function now just sets up search handlers
    
    // Setup search filter (left sidebar)
    const assetSearchLeft = document.getElementById('asset-search-left');
    if (assetSearchLeft) {
        // Remove old listener to avoid duplicates
        const newSearch = assetSearchLeft.cloneNode(true);
        assetSearchLeft.parentNode.replaceChild(newSearch, assetSearchLeft);
        newSearch.addEventListener('input', function(e) {
            filterFolderItems(e.target.value, 'asset');
        });
    }

    // Link search (left sidebar)
    const linkSearchEl = document.getElementById('link-search');
    if (linkSearchEl) {
        // Remove old listener to avoid duplicates
        const newLinkSearch = linkSearchEl.cloneNode(true);
        linkSearchEl.parentNode.replaceChild(newLinkSearch, linkSearchEl);
        newLinkSearch.addEventListener('input', function(e) {
            filterFolderItems(e.target.value, 'link');
        });
    }
}

function filterFolderItems(query, type) {
    const q = (query || '').toLowerCase();
    const container = type === 'asset' ? document.getElementById('asset-groups-list') : document.getElementById('link-groups-list');
    if (!container) return;

    // Filter items inside folders
    container.querySelectorAll('.folder-item-entry').forEach((item) => {
        const itemId = item.dataset.itemId;
        const itemType = item.dataset.itemType;
        if (itemType !== type) return;

        let itemData;
        if (type === 'asset') {
            itemData = assets.find(a => a.id == itemId);
            if (!itemData) return;
            const matches = !q || 
                (itemData.asset_id && itemData.asset_id.toLowerCase().includes(q)) ||
                (itemData.name && itemData.name.toLowerCase().includes(q));
            item.style.display = matches ? '' : 'none';
        } else {
            itemData = links.find(l => l.id == itemId);
            if (!itemData) return;
            const matches = !q || 
                (itemData.link_id && itemData.link_id.toLowerCase().includes(q)) ||
                (itemData.name && itemData.name.toLowerCase().includes(q)) ||
                (itemData.link_type && itemData.link_type.toLowerCase().includes(q));
            item.style.display = matches ? '' : 'none';
        }
    });

    // Show/hide folders based on whether they have visible items
    container.querySelectorAll('.folder-item, .ungrouped-folder').forEach((folder) => {
        const visibleItems = folder.querySelectorAll('.folder-item-entry:not([style*="display: none"])');
        const childFolders = folder.querySelectorAll('.folder-item');
        // Show folder if it has visible items or visible child folders
        if (q && visibleItems.length === 0 && childFolders.length === 0) {
            folder.style.display = 'none';
        } else {
            folder.style.display = '';
        }
    });
}

// Legacy filter functions for backwards compatibility
function filterAssetList(query) {
    filterFolderItems(query, 'asset');
}

function filterLinkList(query) {
    filterFolderItems(query, 'link');
}

function renderSheetsOnCanvas() {
    // Count sheets with images to load
    const sheetsToLoad = sheets.filter(s => s.rendered_image_url).length;
    let sheetsLoaded = 0;

    sheets.forEach((sheet, index) => {
        if (sheet.rendered_image_url) {
            fabric.Image.fromURL(sheet.rendered_image_url, function(img) {
                // If no offset set, offset sheets so they don't stack
                let left = sheet.offset_x;
                let top = sheet.offset_y;
                if (left === 0 && top === 0 && index > 0) {
                    left = index * 50;  // Offset subsequent sheets
                    top = index * 50;
                }

                img.set({
                    left: left,
                    top: top,
                    angle: sheet.rotation,
                    selectable: currentMode === 'select',
                    evented: true,
                    // Disable native Fabric.js borders/controls — they don't
                    // render correctly when the viewport is rotated.  Selection
                    // is indicated with a shadow glow instead (see selectSheet).
                    hasControls: false,
                    hasBorders: false,
                    lockScalingX: true,
                    lockScalingY: true,
                    lockUniScaling: true,
                    lockRotation: false,
                });
                img.sheetData = sheet;
                canvas.add(img);

                // Apply PDF inversion if active (before cuts so filters don't reset clip)
                if (isPdfInverted) {
                    if (!img.filters) img.filters = [];
                    img.filters.push(new fabric.Image.filters.Invert());
                    applyFiltersPreservingSize(img);
                }

                // Restore cut masks if sheet has saved cut data (after filters)
                if (sheet.cuts_json && sheet.cuts_json.length > 0) {
                    sheetCutData[sheet.id] = sheet.cuts_json;
                    applyAllCuts(img, sheet.cuts_json);
                }

                sheetsLoaded++;

                // Once all sheets are loaded, reorder by z_index
                if (sheetsLoaded === sheetsToLoad) {
                    reorderSheetsByZIndex();
                }

                canvas.renderAll();
            }, { crossOrigin: 'anonymous' });
        }
    });
}

/**
 * Reorder sheet objects on canvas based on their z_index values.
 * Lower z_index = further back (rendered first, behind others)
 */
function reorderSheetsByZIndex() {
    // Get all sheet objects from canvas
    const sheetObjects = canvas.getObjects().filter(obj => obj.sheetData);

    if (sheetObjects.length === 0) return;

    // Sort by z_index (ascending - lower values should be at back)
    sheetObjects.sort((a, b) => a.sheetData.z_index - b.sheetData.z_index);

    // Send each sheet to back in reverse order (highest z_index first)
    // This way, the lowest z_index ends up at the very back
    for (let i = sheetObjects.length - 1; i >= 0; i--) {
        canvas.sendToBack(sheetObjects[i]);
    }

    // Bring measurements to front after reordering sheets
    bringMeasurementsToFront();

    canvas.renderAll();
    console.log('Sheets reordered by z_index:', sheetObjects.map(o => ({
        name: o.sheetData.name,
        z_index: o.sheetData.z_index
    })));
}

/**
 * Convert coordinate offsets to meter offsets, handling degree→meter conversion.
 * For degrees: uses equirectangular approximation (1° lat ≈ 111320m).
 * Negates Y for degrees since latitude increases upward but canvas Y increases downward.
 */
function coordOffsetToMeters(dx, dy, refY) {
    const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
    if (isDegrees) {
        const centerLatRad = (refY || 0) * Math.PI / 180;
        return {
            x: dx * 111320 * Math.cos(centerLatRad),
            y: -(dy * 111320)  // Negate: lat-up → canvas-down
        };
    }
    return { x: dx, y: dy };
}

/**
 * Convert meter offsets back to coordinate offsets (inverse of coordOffsetToMeters).
 */
function metersToCoordOffset(mx, my, refY) {
    const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
    if (isDegrees) {
        const centerLatRad = (refY || 0) * Math.PI / 180;
        const cosLat = Math.cos(centerLatRad);
        return {
            x: cosLat !== 0 ? mx / (111320 * cosLat) : 0,
            y: -(my / 111320)  // Negate back: canvas-down → lat-up
        };
    }
    return { x: mx, y: my };
}

/**
 * Convert asset coordinates to pixel coordinates on the canvas.
 * If a reference asset is set, rotates around the reference point.
 * Otherwise falls back to origin-based transform.
 * Handles both meter and degree (lat/lon) coordinate systems.
 */
function assetMeterToPixel(meterX, meterY) {
    const ppm = PROJECT_DATA.pixels_per_meter;
    if (!ppm || !isFinite(ppm) || ppm <= 0) {
        console.warn('assetMeterToPixel: invalid pixels_per_meter:', ppm);
        return { x: 0, y: 0 };
    }

    if (refAssetId) {
        const refAsset = assets.find(a => a.asset_id === refAssetId);
        if (refAsset) {
            const refCoordX = refAsset.current_x;
            const refCoordY = refAsset.current_y;

            // Offset in native coordinates
            const dCoordX = meterX - refCoordX;
            const dCoordY = meterY - refCoordY;

            // Convert to meters (handles degree→meter if needed)
            const dm = coordOffsetToMeters(dCoordX, dCoordY, refCoordY);

            // Rotate by asset layer rotation
            const rad = assetRotationDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const rotX = dm.x * cos - dm.y * sin;
            const rotY = dm.x * sin + dm.y * cos;

            // Scale to pixels and offset from reference pixel position
            return {
                x: refPixelX + rotX * ppm,
                y: refPixelY + rotY * ppm
            };
        }
    }
    // Fallback: origin-based transform (uses meter offsets from origin)
    const dm = coordOffsetToMeters(meterX, meterY, meterY);
    return {
        x: PROJECT_DATA.origin_x + (dm.x * ppm),
        y: PROJECT_DATA.origin_y + (dm.y * ppm)
    };
}

// ============================================================================
// OpenStreetMap Tile Layer Functions
// ============================================================================

/**
 * Convert lat/lon to Web Mercator coordinates (EPSG:3857).
 * Returns { x, y } in meters from origin (0,0 at equator, prime meridian).
 */
function latLonToWebMercator(lat, lon) {
    const R = 6378137; // Earth radius in meters
    const x = R * lon * Math.PI / 180;
    const latRad = lat * Math.PI / 180;
    const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    return { x, y };
}

/**
 * Convert Web Mercator coordinates back to lat/lon.
 */
function webMercatorToLatLon(x, y) {
    const R = 6378137;
    const lon = (x / R) * 180 / Math.PI;
    const lat = (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI;
    return { lat, lon };
}

/**
 * Calculate the appropriate OSM zoom level based on pixels_per_meter and current canvas zoom.
 * OSM zoom levels: 0 (world) to 19 (buildings)
 * At equator: zoom N has ~156543.03 / 2^N meters per pixel
 */
function calculateOSMZoom() {
    const ppm = PROJECT_DATA.pixels_per_meter;
    if (!ppm || ppm <= 0) return 15; // Default zoom
    
    // At equator, OSM zoom 0 has ~156543.03 meters/pixel
    // Our pixels_per_meter is pixels/meter, so meters/pixel = 1/ppm
    // Account for current canvas zoom level
    const effectiveMetersPerPixel = 1 / (ppm * currentZoomLevel);
    const zoom = Math.log2(156543.03 / effectiveMetersPerPixel);
    
    // Clamp to valid range, but prefer higher zoom levels (more detail, fewer tiles)
    // Minimum zoom 10 to prevent loading too many tiles when zoomed out
    return Math.max(10, Math.min(19, Math.round(zoom)));
}

/**
 * Get tile coordinates for a given lat/lon at a specific zoom level.
 * Returns { x, y } tile indices.
 */
function latLonToTile(lat, lon, zoom) {
    const n = Math.pow(2, zoom);
    
    // Clamp latitude to valid range (Web Mercator doesn't work at poles)
    lat = Math.max(-85.0511, Math.min(85.0511, lat));
    
    // Clamp longitude to valid range
    lon = Math.max(-180, Math.min(180, lon));
    
    const x = Math.floor((lon + 180) / 360 * n);
    const latRad = lat * Math.PI / 180;
    const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
    
    // Ensure tile coordinates are within bounds
    return { 
        x: Math.max(0, Math.min(n - 1, x)),
        y: Math.max(0, Math.min(n - 1, y))
    };
}

/**
 * Get lat/lon bounds for a tile.
 */
function tileToBounds(tileX, tileY, zoom) {
    const n = Math.pow(2, zoom);
    const lonMin = tileX / n * 360 - 180;
    const lonMax = (tileX + 1) / n * 360 - 180;
    
    const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - 2 * (tileY + 1) / n)));
    const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - 2 * tileY / n)));
    const latMin = latRadMin * 180 / Math.PI;
    const latMax = latRadMax * 180 / Math.PI;
    
    return { latMin, latMax, lonMin, lonMax };
}

/**
 * Render OpenStreetMap tiles on the canvas.
 * Uses the same coordinate system as the asset layer.
 */
function renderOSMLayer() {
    renderOSMLayerAtZoom(null); // null = auto-calculate zoom
}

/**
 * Render OSM layer at a specific zoom level (or auto-calculate if zoom is null).
 * Smart rendering that preserves existing tiles and only loads/removes as needed.
 * Key: Never remove tiles immediately - only remove them AFTER new tiles are loaded.
 */
function renderOSMLayerAtZoom(forcedZoom) {
    if (!osmEnabled || !refAssetId) {
        return; // Need reference point to render OSM
    }
    
    // Check if we're using lat/lon coordinates
    const isDegrees = ['degrees', 'gda94_geo'].includes(PROJECT_DATA.coord_unit);
    if (!isDegrees) {
        console.warn('OSM layer requires lat/lon coordinate system');
        return;
    }
    
    // Calculate or use forced OSM zoom level
    const zoom = forcedZoom !== null ? forcedZoom : calculateOSMZoom();
    
    console.log(`Rendering OSM at zoom level ${zoom}${forcedZoom !== null ? ' (forced)' : ' (auto)'}`);
    
    // Get canvas viewport bounds
    const vpt = canvas.viewportTransform;
    const canvasWidth = canvas.getWidth();
    const canvasHeight = canvas.getHeight();
    
    // Transform ALL four screen corners to canvas world coordinates
    // This accounts for pan, zoom, AND rotation correctly
    const invVpt = fabric.util.invertTransform(vpt);
    const topLeftCanvas = fabric.util.transformPoint({ x: 0, y: 0 }, invVpt);
    const topRightCanvas = fabric.util.transformPoint({ x: canvasWidth, y: 0 }, invVpt);
    const bottomLeftCanvas = fabric.util.transformPoint({ x: 0, y: canvasHeight }, invVpt);
    const bottomRightCanvas = fabric.util.transformPoint({ x: canvasWidth, y: canvasHeight }, invVpt);
    
    // Convert all four corners to lat/lon (asset coordinates)
    const topLeft = pixelToAssetMeter(topLeftCanvas.x, topLeftCanvas.y);
    const topRight = pixelToAssetMeter(topRightCanvas.x, topRightCanvas.y);
    const bottomLeft = pixelToAssetMeter(bottomLeftCanvas.x, bottomLeftCanvas.y);
    const bottomRight = pixelToAssetMeter(bottomRightCanvas.x, bottomRightCanvas.y);
    
    // Find actual bounds from all four corners (handles rotation)
    const allLons = [topLeft.x, topRight.x, bottomLeft.x, bottomRight.x];
    const allLats = [topLeft.y, topRight.y, bottomLeft.y, bottomRight.y];
    const minLon = Math.min(...allLons);
    const maxLon = Math.max(...allLons);
    const minLat = Math.min(...allLats);
    const maxLat = Math.max(...allLats);
    
    // Validate coordinates are reasonable lat/lon values
    if (!isFinite(minLon) || !isFinite(maxLon) || 
        !isFinite(minLat) || !isFinite(maxLat) ||
        Math.abs(minLat) > 90 || Math.abs(maxLat) > 90 ||
        Math.abs(minLon) > 180 || Math.abs(maxLon) > 180) {
        console.error('Invalid lat/lon coordinates for OSM:', { minLat, maxLat, minLon, maxLon });
        return;
    }
    
    console.log('Viewport bounds (lat/lon):', {
        minLat, maxLat, minLon, maxLon,
        corners: { topLeft, topRight, bottomLeft, bottomRight }
    });
    
    // Get tile coordinates for the exact viewport bounds (no padding yet)
    const tileTL_noPad = latLonToTile(maxLat, minLon, zoom);
    const tileBR_noPad = latLonToTile(minLat, maxLon, zoom);
    
    // Calculate base tile count without padding
    const baseTileCountX = tileBR_noPad.x - tileTL_noPad.x + 1;
    const baseTileCountY = tileBR_noPad.y - tileTL_noPad.y + 1;
    const baseTileCount = baseTileCountX * baseTileCountY;
    
    console.log(`Base viewport coverage: ${baseTileCountX}x${baseTileCountY} = ${baseTileCount} tiles`);
    
    // Adjust padding based on tile count and canvas rotation
    // When rotated, we need more padding because the visible area is larger
    let tilePadding = 1;
    const isRotated = Math.abs(viewportRotation % 90) > 0.5; // Not aligned to 90° increments
    const rotationPaddingMultiplier = isRotated ? 1.5 : 1; // 50% more padding when rotated
    
    if (baseTileCount > 80) {
        tilePadding = Math.ceil(0 * rotationPaddingMultiplier); // No padding if already covering many tiles
    } else if (baseTileCount > 40) {
        tilePadding = Math.ceil(1 * rotationPaddingMultiplier); // Minimal padding for medium coverage
    } else {
        tilePadding = Math.ceil(2 * rotationPaddingMultiplier); // More padding for small coverage (better panning UX)
    }
    
    const tileTL = {
        x: Math.max(0, tileTL_noPad.x - tilePadding),
        y: Math.max(0, tileTL_noPad.y - tilePadding)
    };
    const tileBR = {
        x: Math.min(Math.pow(2, zoom) - 1, tileBR_noPad.x + tilePadding),
        y: Math.min(Math.pow(2, zoom) - 1, tileBR_noPad.y + tilePadding)
    };
    
    // Calculate final tile count
    const tileCountX = tileBR.x - tileTL.x + 1;
    const tileCountY = tileBR.y - tileTL.y + 1;
    const tileCount = tileCountX * tileCountY;
    
    console.log(`Final OSM: ${tileCountX}x${tileCountY} = ${tileCount} tiles at zoom ${zoom} (padding: ${tilePadding})`);
    console.log(`Tile range: X[${tileTL.x} to ${tileBR.x}], Y[${tileTL.y} to ${tileBR.y}]`);
    
    // Limit number of tiles to prevent overload
    const maxTiles = 150; // Increased slightly
    if (tileCount > maxTiles) {
        // Try to render anyway but with reduced zoom level
        const reducedZoom = zoom - 1;
        if (reducedZoom >= 10) {
            console.warn(`Too many tiles (${tileCount}) at zoom ${zoom}, automatically reducing to zoom ${reducedZoom}`);
            
            // Show temporary status message
            const statusBar = document.getElementById('status-bar');
            if (statusBar) {
                const originalContent = statusBar.innerHTML;
                statusBar.innerHTML = `⚠️ OSM: Viewport too large, using lower detail (zoom ${reducedZoom}/${zoom})`;
                setTimeout(() => {
                    statusBar.innerHTML = originalContent;
                }, 3000);
            }
            
            // Recursively call with reduced zoom
            renderOSMLayerAtZoom(reducedZoom);
            return;
        } else {
            console.error(`Viewport too large for OSM rendering. Tiles needed: ${tileCount}, max: ${maxTiles}. Try zooming in.`);
            
            // Show error message
            const statusBar = document.getElementById('status-bar');
            if (statusBar) {
                const originalContent = statusBar.innerHTML;
                statusBar.innerHTML = `❌ OSM: Viewport too large to render (${tileCount} tiles needed). Zoom in or pan to smaller area.`;
                setTimeout(() => {
                    statusBar.innerHTML = originalContent;
                }, 5000);
            }
            return;
        }
    }
    
    // Create set of needed tiles in viewport
    const neededTiles = new Set();
    for (let tileX = tileTL.x; tileX <= tileBR.x; tileX++) {
        for (let tileY = tileTL.y; tileY <= tileBR.y; tileY++) {
            neededTiles.add(`${tileX}_${tileY}_${zoom}`);
        }
    }
    
    // Validate existing tiles on canvas - remove any that don't match current dark mode
    osmLoadedTiles.forEach((tileObj, tileKey) => {
        if (tileObj.darkMode !== osmDarkMode) {
            console.warn(`Tile ${tileKey} was loaded in ${tileObj.darkMode ? 'dark' : 'light'} mode, removing for theme mismatch`);
            canvas.remove(tileObj.tile);
            osmTiles = osmTiles.filter(t => t !== tileObj.tile);
            osmLoadedTiles.delete(tileKey);
        }
    });
    
    // Check if zoom has actually changed
    const zoomChanged = osmCurrentZoom !== null && osmCurrentZoom !== zoom;
    if (zoomChanged) {
        console.log(`OSM zoom changed from ${osmCurrentZoom} to ${zoom}`);
        osmCurrentZoom = zoom;
        
        // Mark old zoom tiles for deletion, but don't delete yet
        // This way they stay visible while new tiles load
        osmLoadedTiles.forEach((tileObj, tileKey) => {
            if (!neededTiles.has(tileKey)) {
                tileObj.pendingDelete = true;
                console.log(`Marking for deletion (will remove after new tiles load): ${tileKey}`);
            }
        });
    } else {
        osmCurrentZoom = zoom;
        
        // Same zoom level - remove tiles that are outside viewport immediately
        osmLoadedTiles.forEach((tileObj, tileKey) => {
            if (!neededTiles.has(tileKey)) {
                canvas.remove(tileObj.tile);
                osmTiles = osmTiles.filter(t => t !== tileObj.tile);
                osmLoadedTiles.delete(tileKey);
                console.log(`Removed off-screen tile: ${tileKey}`);
            }
        });
    }
    
    // Load only tiles that aren't already loaded
    let tilesLoading = 0;
    for (let tileX = tileTL.x; tileX <= tileBR.x; tileX++) {
        for (let tileY = tileTL.y; tileY <= tileBR.y; tileY++) {
            const tileKey = `${tileX}_${tileY}_${zoom}`;
            if (!osmLoadedTiles.has(tileKey)) {
                loadOSMTile(tileX, tileY, zoom);
                tilesLoading++;
            }
        }
    }
    
    // If zoom changed and tiles are loading, schedule cleanup of old tiles
    if (zoomChanged && tilesLoading > 0) {
        // After a short delay (allowing new tiles to load), remove marked tiles
        setTimeout(() => {
            console.log('Cleaning up old zoom level tiles after new ones loaded');
            osmLoadedTiles.forEach((tileObj, tileKey) => {
                if (tileObj.pendingDelete) {
                    canvas.remove(tileObj.tile);
                    osmTiles = osmTiles.filter(t => t !== tileObj.tile);
                    osmLoadedTiles.delete(tileKey);
                    console.log(`Cleaned up: ${tileKey}`);
                }
            });
            canvas.renderAll();
        }, 200); // 200ms gives tiles time to start loading before cleanup
    }
}

/**
 * Load a single OSM tile and add it to the canvas.
 */
function loadOSMTile(tileX, tileY, zoom) {
    // Choose tile server based on dark mode
    // Option 1: Different tile servers for light/dark modes
    // Option 2: Use CSS filters to darken standard OSM tiles
    let url;
    const useDarkTileServer = true; // Set to false to use filters instead
    
    if (osmDarkMode && useDarkTileServer) {
        // CartoDB Dark Matter - professionally designed dark themed tiles
        // Alternative providers:
        // - Stamen Toner: `https://stamen-tiles.a.ssl.fastly.net/toner/${zoom}/${tileX}/${tileY}.png`
        // - CARTO Dark: `https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/${zoom}/${tileX}/${tileY}.png`
        url = `https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/${zoom}/${tileX}/${tileY}.png`;
    } else {
        // Standard OpenStreetMap tiles
        url = `https://tile.openstreetmap.org/${zoom}/${tileX}/${tileY}.png`;
    }
    
    // Check cache first
    const cachedDataUrl = getOSMTileFromCache(tileX, tileY, zoom, osmDarkMode);
    if (cachedDataUrl) {
        // Use cached tile immediately
        addOSMTileToCanvas(cachedDataUrl, tileX, tileY, zoom);
        return;
    }
    
    // Tile not in cache, download it
    // Get tile bounds in lat/lon
    const bounds = tileToBounds(tileX, tileY, zoom);
    
    console.log(`Downloading tile [${tileX},${tileY}] from ${osmDarkMode ? 'Dark' : 'Light'} server...`);
    
    // Load tile image from URL
    fabric.Image.fromURL(url, function(img) {
        if (!img.getElement()) {
            console.warn(`Failed to load tile [${tileX},${tileY}]`);
            return;
        }
        
        // Convert to data URL and cache it
        const canvas_temp = document.createElement('canvas');
        canvas_temp.width = img.width;
        canvas_temp.height = img.height;
        const ctx = canvas_temp.getContext('2d');
        ctx.drawImage(img.getElement(), 0, 0);
        const dataUrl = canvas_temp.toDataURL('image/png');
        
        // Store in cache
        storeOSMTileInCache(tileX, tileY, zoom, osmDarkMode, dataUrl);
        
        // Add to canvas
        addOSMTileToCanvas(dataUrl, tileX, tileY, zoom);
    }, { crossOrigin: 'anonymous' });
}

/**
 * Add an OSM tile (from cache or fresh) to the canvas.
 * Handles positioning, rotation, and filtering.
 */
function addOSMTileToCanvas(dataUrl, tileX, tileY, zoom) {
    const bounds = tileToBounds(tileX, tileY, zoom);
    const useDarkTileServer = true; // Must match the setting in loadOSMTile
    
    // Convert all four corners to pixel coordinates
    // This handles rotation properly
    const topLeft = assetMeterToPixel(bounds.lonMin, bounds.latMax);
    const topRight = assetMeterToPixel(bounds.lonMax, bounds.latMax);
    const bottomLeft = assetMeterToPixel(bounds.lonMin, bounds.latMin);
    const bottomRight = assetMeterToPixel(bounds.lonMax, bounds.latMin);
    
    // Calculate center point and dimensions
    const centerX = (topLeft.x + topRight.x + bottomLeft.x + bottomRight.x) / 4;
    const centerY = (topLeft.y + topRight.y + bottomLeft.y + bottomRight.y) / 4;
    
    // Calculate width and height from transformed coordinates
    const width = Math.sqrt(Math.pow(topRight.x - topLeft.x, 2) + Math.pow(topRight.y - topLeft.y, 2));
    const height = Math.sqrt(Math.pow(bottomLeft.x - topLeft.x, 2) + Math.pow(bottomLeft.y - topLeft.y, 2));
    
    // Calculate rotation angle from the transformed top edge
    const angle = Math.atan2(topRight.y - topLeft.y, topRight.x - topLeft.x) * 180 / Math.PI;
    
    console.log(`Adding tile [${tileX},${tileY}] to canvas (cached: ${getOSMCacheStats().hitRate})`);
    
    // Load tile image from data URL
    fabric.Image.fromURL(dataUrl, function(img) {
        if (!img.getElement()) {
            console.warn(`Failed to create image from tile [${tileX},${tileY}]`);
            return;
        }
        
        // Apply dark mode filter if using standard OSM tiles in dark mode
        if (osmDarkMode && !useDarkTileServer) {
            // Apply CSS-style filters to darken standard OSM tiles
            img.filters = [
                new fabric.Image.filters.Brightness({ brightness: -0.3 }),
                new fabric.Image.filters.Contrast({ contrast: -0.1 }),
                new fabric.Image.filters.Saturation({ saturation: -0.4 })
            ];
            img.applyFilters();
        }
        
        img.set({
            left: centerX,
            top: centerY,
            originX: 'center',
            originY: 'center',
            scaleX: width / 256, // OSM tiles are 256x256
            scaleY: height / 256,
            angle: angle, // Apply rotation to match asset layer
            opacity: osmOpacity,
            selectable: false,
            evented: false,
            isOSMTile: true,
            osmDarkMode: osmDarkMode, // Track which mode this tile was loaded in
            osmTileLoadedAt: Date.now(), // Track when tile was loaded to detect stale tiles
            tileInfo: { x: tileX, y: tileY, zoom: zoom } // Debug info
        });
        
        canvas.add(img);
        osmTiles.push(img);
        
        // Track that this tile is now loaded
        const tileKey = `${tileX}_${tileY}_${zoom}`;
        osmLoadedTiles.set(tileKey, { tile: img, zoom: zoom, darkMode: osmDarkMode, loadedAt: Date.now() });
        
        // Set z-index ordering
        applyOSMZIndex();
        
        // Bring measurements to front (they should always be visible on top)
        bringMeasurementsToFront();
        
        canvas.renderAll();
    }, { crossOrigin: 'anonymous' });
}

// ============================================================================
// OSM Tile Cache Management
// ============================================================================

/**
 * Generate cache key for a tile.
 */
function getOSMCacheKey(tileX, tileY, zoom, isDarkMode) {
    return `osm_tile_${zoom}_${tileX}_${tileY}_${isDarkMode ? 'dark' : 'light'}`;
}

/**
 * Get tile from cache.
 */
function getOSMTileFromCache(tileX, tileY, zoom, isDarkMode) {
    const key = getOSMCacheKey(tileX, tileY, zoom, isDarkMode);
    if (osmTileCache[key]) {
        osmTileCacheStats.hits++;
        console.log(`Cache HIT: ${key} (${osmTileCacheStats.hits} hits, ${osmTileCacheStats.misses} misses)`);
        return osmTileCache[key];
    }
    osmTileCacheStats.misses++;
    return null;
}

/**
 * Store tile in cache with size management.
 */
function storeOSMTileInCache(tileX, tileY, zoom, isDarkMode, dataUrl) {
    const key = getOSMCacheKey(tileX, tileY, zoom, isDarkMode);
    
    // Estimate size (rough approximation: data URL length)
    const estimatedSize = dataUrl.length;
    
    // Check if we need to make room
    if (osmTileCacheStats.currentSize + estimatedSize > osmTileCacheStats.maxSize) {
        // Remove oldest/least used tiles until we have space
        pruneOSMTileCache(estimatedSize);
    }
    
    // Store tile
    osmTileCache[key] = dataUrl;
    osmTileCacheStats.currentSize += estimatedSize;
    
    // Only log cache status periodically (every ~10 tiles)
    if (Math.random() < 0.1) {
        console.log(`OSM Cache: ${(osmTileCacheStats.currentSize / 1024 / 1024).toFixed(2)} MB / ${(osmTileCacheStats.maxSize / 1024 / 1024).toFixed(1)} MB`);
    }
}

/**
 * Prune cache by removing tiles until enough space is available.
 * Uses a simple FIFO approach (first added, first removed).
 */
function pruneOSMTileCache(requiredSpace) {
    console.log(`Pruning cache: need ${(requiredSpace / 1024 / 1024).toFixed(2)} MB`);
    
    const cacheKeys = Object.keys(osmTileCache);
    let freedSpace = 0;
    let deletedCount = 0;
    
    // Remove tiles until we have enough space
    for (let i = 0; i < cacheKeys.length && freedSpace < requiredSpace; i++) {
        const key = cacheKeys[i];
        const dataUrl = osmTileCache[key];
        const tileSize = dataUrl.length;
        
        delete osmTileCache[key];
        osmTileCacheStats.currentSize -= tileSize;
        freedSpace += tileSize;
        deletedCount++;
    }
    
    console.log(`Pruned ${deletedCount} tiles, freed ${(freedSpace / 1024 / 1024).toFixed(2)} MB`);
}

/**
 * Clear entire OSM tile cache.
 */
function clearOSMTileCache() {
    osmTileCache = {};
    osmTileCacheStats.currentSize = 0;
    osmTileCacheStats.hits = 0;
    osmTileCacheStats.misses = 0;
    console.log('OSM tile cache cleared');
}

/**
 * Get cache statistics.
 */
function getOSMCacheStats() {
    const hitRate = osmTileCacheStats.hits + osmTileCacheStats.misses > 0 
        ? (osmTileCacheStats.hits / (osmTileCacheStats.hits + osmTileCacheStats.misses) * 100).toFixed(1)
        : 0;
    
    return {
        size: `${(osmTileCacheStats.currentSize / 1024 / 1024).toFixed(2)} MB / ${(osmTileCacheStats.maxSize / 1024 / 1024).toFixed(1)} MB`,
        tiles: Object.keys(osmTileCache).length,
        hits: osmTileCacheStats.hits,
        misses: osmTileCacheStats.misses,
        hitRate: `${hitRate}%`,
        cacheUtilization: `${(osmTileCacheStats.currentSize / osmTileCacheStats.maxSize * 100).toFixed(1)}%`
    };
}

/**
 * Apply z-index ordering to OSM tiles.
 */
function applyOSMZIndex() {
    osmTiles.forEach(tile => {
        if (osmZIndex === 0) {
            // Bottom - below sheets
            tile.sendToBack();
        } else if (osmZIndex === 1) {
            // Between sheets and assets
            const sheets = canvas.getObjects().filter(obj => obj.isSheetImage);
            sheets.forEach(sheet => tile.moveTo(canvas.getObjects().indexOf(sheet) + 1));
        } else {
            // Top - above everything
            tile.bringToFront();
        }
    });
}

/**
 * Clear all OSM tiles from canvas.
 */
function clearOSMLayer() {
    osmTiles.forEach(tile => canvas.remove(tile));
    osmTiles = [];
    osmLoadedTiles.clear();
}

/**
 * Debounced refresh of OSM layer (for pan/zoom events).
 */
function debouncedRefreshOSM() {
    if (!osmEnabled) return;
    
    if (osmRefreshTimeout) {
        clearTimeout(osmRefreshTimeout);
    }
    osmRefreshTimeout = setTimeout(() => {
        console.log('Refreshing OSM tiles for new viewport');
        renderOSMLayer();
    }, 300); // 300ms debounce
}

/**
 * Toggle OSM layer visibility.
 */
function toggleOSMLayer() {
    osmEnabled = !osmEnabled;
    if (osmEnabled) {
        renderOSMLayer();
    } else {
        clearOSMLayer();
    }
    canvas.renderAll();
    
    // Update UI toggle button
    const btn = document.getElementById('osm-toggle-btn');
    if (btn) {
        btn.style.background = osmEnabled ? 'var(--bg-tool-btn-active)' : 'var(--bg-tool-btn)';
        btn.style.color = osmEnabled ? '#ffffff' : 'inherit';
    }
    
    // Save setting to server
    saveOSMSettings();
}

/**
 * Update OSM layer opacity.
 */
function updateOSMOpacity(opacity) {
    osmOpacity = parseFloat(opacity);
    osmTiles.forEach(tile => tile.set('opacity', osmOpacity));
    canvas.renderAll();
    saveOSMSettings();
}

/**
 * Update OSM layer z-index.
 */
function updateOSMZIndex(zIndex) {
    osmZIndex = parseInt(zIndex);
    applyOSMZIndex();
    canvas.renderAll();
    saveOSMSettings();
}

/**
 * Save OSM settings to the server.
 */
async function saveOSMSettings() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                osm_enabled: osmEnabled,
                osm_opacity: osmOpacity,
                osm_z_index: osmZIndex
            })
        });

        if (response.ok) {
            const result = await response.json();
            PROJECT_DATA.osm_enabled = result.osm_enabled;
            PROJECT_DATA.osm_opacity = result.osm_opacity;
            PROJECT_DATA.osm_z_index = result.osm_z_index;
            console.log('OSM settings saved');
        } else {
            console.error('Failed to save OSM settings:', await response.text());
        }
    } catch (error) {
        console.error('Error saving OSM settings:', error);
    }
}

function renderAssetsOnCanvas() {
    // Only render assets on canvas if a reference point has been placed
    if (!refAssetId || (refPixelX === 0 && refPixelY === 0)) {
        return;
    }

    assets.forEach(asset => {
        // Check if asset's group is visible
        if (asset.layer_group && groupVisibility[asset.layer_group] === false) {
            return;  // Skip hidden group assets
        }

        const pos = assetMeterToPixel(asset.current_x, asset.current_y);

        const assetObj = createAssetShape(asset, pos.x, pos.y);
        assetObj.assetData = asset;
        canvas.add(assetObj);
    });

    canvas.renderAll();
}

function createAssetShape(asset, x, y) {
    const type = asset.asset_type_data;
    const color = type ? type.color : '#FF0000';
    const size = type ? type.size : 20;
    // If a custom icon image has been uploaded, always use 'custom' rendering
    const shape = (type && type.custom_icon) ? 'custom' : (type ? type.icon_shape : 'circle');

    let obj;

    switch(shape) {
        case 'circle':
            obj = new fabric.Circle({
                radius: size / 2,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'square':
            obj = new fabric.Rect({
                width: size,
                height: size,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'triangle':
            obj = new fabric.Triangle({
                width: size,
                height: size,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'diamond':
            obj = new fabric.Rect({
                width: size * 0.7,
                height: size * 0.7,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                angle: 45,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'star':
            const points = createStarPoints(0, 0, 5, size / 2, size / 4);
            obj = new fabric.Polygon(points, {
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            break;
        case 'custom':
            // Start with placeholder; async-load custom icon image
            obj = new fabric.Circle({
                radius: size / 2,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
            if (type && type.custom_icon) {
                const iconUrl = type.custom_icon;
                const targetSize = size;
                const placeholder = obj;
                setTimeout(() => {
                    fabric.Image.fromURL(iconUrl, function(img) {
                        if (!img || !img.width) return;
                        // Scale uniformly to fit within targetSize, preserving aspect ratio
                        var scale = targetSize / Math.max(img.width, img.height);
                        img.set({
                            scaleX: scale,
                            scaleY: scale,
                            originX: 'center',
                            originY: 'center'
                        });
                        var oldGroup = placeholder.group;
                        if (oldGroup) {
                            var groupLeft = oldGroup.left;
                            var groupTop = oldGroup.top;
                            // Build a new label matching the original
                            var labelText = asset.name || asset.asset_id;
                            var newLabel = new fabric.Text(labelText, {
                                fontSize: 10,
                                fill: '#000',
                                originX: 'left',
                                originY: 'center'
                            });
                            var newGroup = new fabric.Group([img, newLabel], {
                                left: groupLeft,
                                top: groupTop,
                                selectable: true,
                                hasControls: false,
                                hasBorders: true,
                                lockScalingX: true,
                                lockScalingY: true,
                                lockRotation: true,
                                cornerSize: 0
                            });
                            newGroup.setControlsVisibility({
                                tl: false, tr: false, bl: false, br: false,
                                ml: false, mt: false, mr: false, mb: false,
                                mtr: false
                            });
                            // Copy data reference from old group
                            newGroup.assetData = oldGroup.assetData;
                            canvas.remove(oldGroup);
                            canvas.add(newGroup);
                            canvas.renderAll();
                        }
                    }, { crossOrigin: 'anonymous' });
                }, 0);
            }
            break;
        default:
            obj = new fabric.Circle({
                radius: size / 2,
                fill: color,
                stroke: '#000',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center'
            });
    }

    obj.set({
        left: x,
        top: y,
        selectable: true,
        hasControls: false
    });

    // Add label
    const label = new fabric.Text(asset.name || asset.asset_id, {
        fontSize: 10,
        fill: '#000',
        left: x + size / 2 + 3,
        top: y - 5,
        selectable: false
    });

    const group = new fabric.Group([obj, label], {
        left: x,
        top: y,
        selectable: true,
        hasControls: false,
        hasBorders: true,
        lockScalingX: true,
        lockScalingY: true,
        lockRotation: true,
        cornerSize: 0
    });
    // Hide all control handles
    group.setControlsVisibility({
        tl: false, tr: false, bl: false, br: false,
        ml: false, mt: false, mr: false, mb: false,
        mtr: false
    });

    return group;
}

function createStarPoints(cx, cy, spikes, outerRadius, innerRadius) {
    const points = [];
    const step = Math.PI / spikes;

    for (let i = 0; i < 2 * spikes; i++) {
        const radius = i % 2 === 0 ? outerRadius : innerRadius;
        const angle = i * step - Math.PI / 2;
        points.push({
            x: cx + Math.cos(angle) * radius,
            y: cy + Math.sin(angle) * radius
        });
    }

    return points;
}

/**
 * Render all links on the canvas as polylines.
 * Links are rendered if a reference point has been placed (same as assets).
 */
function renderLinksOnCanvas() {
    // Remove existing link objects
    const existingLinks = canvas.getObjects().filter(obj => obj.isLinkObject);
    existingLinks.forEach(obj => canvas.remove(obj));

    // Only render links if a reference point has been placed
    if (!refAssetId || (refPixelX === 0 && refPixelY === 0)) {
        return;
    }

    // Only render if links are visible
    if (!linksVisible) {
        canvas.renderAll();
        return;
    }

    links.forEach(link => {
        // Check if link's group is visible
        if (link.layer_group && groupVisibility[link.layer_group] === false) {
            return;  // Skip hidden group links
        }

        if (!link.coordinates || link.coordinates.length < 2) {
            return;
        }

        // Convert coordinates to pixel positions
        const points = link.coordinates.map(coord => {
            // coordinates are [lon, lat] which map to [x, y]
            const pos = assetMeterToPixel(coord[0], coord[1]);
            return { x: pos.x, y: pos.y };
        });

        // Create polyline
        const polyline = new fabric.Polyline(points, {
            fill: 'transparent',
            stroke: link.color || '#0066FF',
            strokeWidth: link.width || 2,
            opacity: link.opacity || 1.0,
            selectable: false,
            evented: false,
            isLinkObject: true,
            linkData: link
        });

        canvas.add(polyline);
    });

    // Position all links above sheets and OSM tiles but below assets
    // First, find the topmost sheet/OSM object
    const objects = canvas.getObjects();
    let insertIndex = 0;
    objects.forEach((obj, idx) => {
        if (obj.sheetData || obj.isOSMTile) {
            insertIndex = Math.max(insertIndex, idx + 1);
        }
    });
    
    // Move all link objects to just above sheets/OSM
    const linkObjects = objects.filter(obj => obj.isLinkObject);
    linkObjects.forEach(linkObj => {
        canvas.moveTo(linkObj, insertIndex);
    });

    canvas.renderAll();
}

/**
 * Render the link list in the sidebar panel.
 * Links are now rendered inside folders by renderLinkGroupList()
 */
function renderLinkList() {
    // Links are now rendered inside folders by renderLinkGroupList()
    // This function is kept for backwards compatibility
}

/**
 * Highlight a link on the canvas briefly.
 */
function highlightLink(link) {
    const linkObjs = canvas.getObjects().filter(obj => obj.isLinkObject && obj.linkData && obj.linkData.id === link.id);
    if (linkObjs.length === 0) return;

    const obj = linkObjs[0];
    const originalStroke = obj.stroke;
    const originalWidth = obj.strokeWidth;

    // Flash highlight
    obj.set({ stroke: '#FFD700', strokeWidth: originalWidth + 2 });
    canvas.renderAll();

    setTimeout(() => {
        obj.set({ stroke: originalStroke, strokeWidth: originalWidth });
        canvas.renderAll();
    }, 500);
}

/**
 * Toggle link layer visibility.
 */
function toggleLinksVisibility(visible) {
    linksVisible = visible;
    renderLinksOnCanvas();
}

// Context-sensitive floating toolbar buttons
function updateContextTools() {
    const hasSheet = !!selectedSheet;
    const hasCut = hasSheet && sheetCutData[selectedSheet.id] && sheetCutData[selectedSheet.id].length > 0;

    const flipBtn = document.getElementById('ftool-flip');
    const clearCutBtn = document.getElementById('ftool-clear-cut');
    const showUncutBtn = document.getElementById('ftool-show-uncut');

    if (flipBtn) flipBtn.style.display = hasSheet ? 'flex' : 'none';
    if (clearCutBtn) clearCutBtn.style.display = hasSheet ? 'flex' : 'none';
    if (showUncutBtn) showUncutBtn.style.display = (hasSheet && hasCut) ? 'flex' : 'none';

    // Update show-uncut active state
    if (showUncutBtn) {
        showUncutBtn.classList.toggle('active', showUncutSheetId === (selectedSheet && selectedSheet.id));
    }
}

// Selection Handlers
function handleSelectClick(opt) {
    const target = opt.target;

    if (target) {
        if (target.assetData) {
            selectAsset(target.assetData.id);
        } else if (target.sheetData) {
            selectSheet(target.sheetData.id);
        }
    } else {
        clearSelection();
    }
}

function selectSheet(sheetId) {
    // Reset show-uncut if switching to a different sheet
    if (showUncutSheetId !== null && showUncutSheetId !== sheetId) {
        const prevObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === showUncutSheetId
        );
        if (prevObj) {
            prevObj._showUncut = false;
            prevObj.dirty = true;
        }
        showUncutSheetId = null;
    }

    selectedSheet = sheets.find(s => s.id === sheetId);
    selectedAsset = null;

    // Highlight selected sheet with a glow shadow on canvas
    // (native Fabric.js borders break under viewport rotation)
    const selectionShadow = new fabric.Shadow({
        color: 'rgba(52, 152, 219, 0.7)',
        blur: 20,
        offsetX: 0,
        offsetY: 0,
    });
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) {
            if (obj.sheetData.id === sheetId) {
                obj.shadow = selectionShadow;
                // Sync Fabric.js active object so dragging/rotating works
                // Only in select mode — other modes (crop/split) need selectSheet
                // for state tracking but must NOT make the object draggable
                if (currentMode === 'select' && canvas.getActiveObject() !== obj) {
                    canvas.setActiveObject(obj);
                }
            } else {
                obj.shadow = null;
            }
        }
    });
    canvas.renderAll();

    // Update layer list
    document.querySelectorAll('.layer-item').forEach(item => {
        item.classList.toggle('selected', parseInt(item.dataset.sheetId) === sheetId);
    });

    // Show properties
    document.getElementById('no-selection').style.display = 'none';
    document.getElementById('sheet-properties').style.display = 'block';
    document.getElementById('asset-properties').style.display = 'none';

    // Populate fields
    document.getElementById('sheet-name').value = selectedSheet.name;
    document.getElementById('sheet-offset-x').value = selectedSheet.offset_x;
    document.getElementById('sheet-offset-y').value = selectedSheet.offset_y;
    document.getElementById('sheet-rotation').value = selectedSheet.rotation;
    document.getElementById('sheet-zindex').value = selectedSheet.z_index;
    updateContextTools();
}

function selectAsset(assetId) {
    selectedAsset = assets.find(a => a.id === assetId);
    selectedSheet = null;

    // Clear sheet selection shadow and highlight asset on canvas
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) obj.shadow = null;
        if (obj.assetData && obj.assetData.id === assetId) {
            canvas.setActiveObject(obj);
        }
    });

    // Show properties
    document.getElementById('no-selection').style.display = 'none';
    document.getElementById('sheet-properties').style.display = 'none';
    document.getElementById('asset-properties').style.display = 'block';

    // Populate fields
    document.getElementById('asset-id').value = selectedAsset.asset_id;
    document.getElementById('asset-name').value = selectedAsset.name || '';
    document.getElementById('asset-orig-x').value = selectedAsset.original_x;
    document.getElementById('asset-orig-y').value = selectedAsset.original_y;
    document.getElementById('asset-adj-x').value = selectedAsset.adjusted_x || selectedAsset.original_x;
    document.getElementById('asset-adj-y').value = selectedAsset.adjusted_y || selectedAsset.original_y;

    showTab('properties');
}

function selectLink(linkId) {
    // Find and highlight the link on canvas
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) obj.shadow = null;
        if (obj.isLinkObject && obj.linkData && obj.linkData.id === linkId) {
            canvas.setActiveObject(obj);
            // Zoom to link
            const bounds = obj.getBoundingRect();
            const center = {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2
            };
            canvas.viewportCenterObject(obj);
        }
    });
    canvas.renderAll();
}

let _clearingSelection = false;
function clearSelection() {
    // Guard against re-entrant calls (discardActiveObject fires selection:cleared)
    if (_clearingSelection) return;
    _clearingSelection = true;

    // Reset show-uncut state
    if (showUncutSheetId !== null) {
        const prevObj = canvas.getObjects().find(obj =>
            obj.sheetData && obj.sheetData.id === showUncutSheetId
        );
        if (prevObj) {
            prevObj._showUncut = false;
            prevObj.dirty = true;
        }
        showUncutSheetId = null;
    }

    selectedSheet = null;
    selectedAsset = null;
    canvas.discardActiveObject();

    // Clear selection shadow from all sheets
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData) obj.shadow = null;
    });
    canvas.renderAll();
    _clearingSelection = false;

    // Clear selected measurement
    selectedMeasurementId = null;
    document.querySelectorAll('.folder-item-entry.selected-measurement').forEach(el => {
        el.classList.remove('selected-measurement');
    });

    document.querySelectorAll('.layer-item').forEach(item => {
        item.classList.remove('selected');
    });

    document.getElementById('no-selection').style.display = 'block';
    document.getElementById('sheet-properties').style.display = 'none';
    document.getElementById('asset-properties').style.display = 'none';
    updateContextTools();
}

// Delete selected sheet
async function deleteSelectedSheet() {
    if (!selectedSheet) {
        console.log('No sheet selected for deletion');
        return;
    }

    const sheetName = selectedSheet.name;
    const confirmed = confirm(`Are you sure you want to delete "${sheetName}"? This cannot be undone.`);

    if (!confirmed) return;

    try {
        const response = await fetch(`/api/sheets/${selectedSheet.id}/`, {
            method: 'DELETE',
            headers: {
                'X-CSRFToken': getCSRFToken()
            }
        });

        if (response.ok || response.status === 204) {
            // Remove from canvas
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData && obj.sheetData.id === selectedSheet.id) {
                    canvas.remove(obj);
                }
            });
            canvas.renderAll();

            // Remove from local data
            const index = sheets.findIndex(s => s.id === selectedSheet.id);
            if (index >= 0) {
                sheets.splice(index, 1);
            }

            // Clear cut data for this sheet
            delete sheetCutData[selectedSheet.id];

            // Clear selection and refresh UI
            clearSelection();
            renderSheetLayers();

            console.log('Sheet deleted:', sheetName);
            if (typeof showToast === 'function') {
                showToast(`Sheet "${sheetName}" deleted`, 'success');
            }
            return true;
        } else {
            const error = await response.json();
            if (typeof showToast === 'function') {
                showToast('Error deleting sheet: ' + JSON.stringify(error), 'error');
            } else {
                alert('Error deleting sheet: ' + JSON.stringify(error));
            }
            return false;
        }
    } catch (error) {
        console.error('Error deleting sheet:', error);
        if (typeof showToast === 'function') {
            showToast('Error deleting sheet', 'error');
        } else {
            alert('Error deleting sheet');
        }
        return false;
    }
}

/**
 * Delete a sheet by ID (used by unified ToolSectionItem module)
 */
async function deleteSheet(sheetId, sheetName) {
    if (!confirm(`Delete sheet "${sheetName}"? This cannot be undone.`)) return false;

    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });

        if (response.ok || response.status === 204) {
            // Remove from canvas
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData && obj.sheetData.id === sheetId) {
                    canvas.remove(obj);
                }
            });
            canvas.renderAll();

            // Remove from local data
            const index = sheets.findIndex(s => s.id === sheetId);
            if (index >= 0) {
                sheets.splice(index, 1);
            }

            // Clear cut data for this sheet
            delete sheetCutData[sheetId];

            // Clear selection if this was selected
            if (selectedSheet && selectedSheet.id === sheetId) {
                clearSelection();
            }
            
            // Refresh UI
            renderSheetLayers();
            renderSheetGroupList();
            
            if (typeof showToast === 'function') {
                showToast(`Sheet "${sheetName}" deleted`, 'success');
            }
            return true;
        } else {
            if (typeof showToast === 'function') {
                showToast('Failed to delete sheet', 'error');
            }
            return false;
        }
    } catch (error) {
        console.error('Error deleting sheet:', error);
        if (typeof showToast === 'function') {
            showToast('Error deleting sheet', 'error');
        }
        return false;
    }
}

// Calibration
function handleCalibrationClick(opt) {
    const pointer = canvas.getPointer(opt.e);
    calibrationPoints.push({ x: pointer.x, y: pointer.y });

    // Draw calibration point marker
    const marker = new fabric.Circle({
        radius: 5,
        fill: '#FF0000',
        left: pointer.x,
        top: pointer.y,
        originX: 'center',
        originY: 'center',
        selectable: false,
        calibrationMarker: true
    });
    canvas.add(marker);

    if (calibrationPoints.length === 2) {
        // Calculate pixel distance
        const dx = calibrationPoints[1].x - calibrationPoints[0].x;
        const dy = calibrationPoints[1].y - calibrationPoints[0].y;
        const pixelDistance = Math.sqrt(dx * dx + dy * dy);

        document.getElementById('pixel-distance').value = pixelDistance.toFixed(2);
        document.getElementById('calibrateModal').style.display = 'block';
    }
}

async function applyCalibration() {
    const pixelDistance = parseFloat(document.getElementById('pixel-distance').value);
    const realDistance = parseFloat(document.getElementById('real-distance').value);

    if (!realDistance || realDistance <= 0) {
        alert('Please enter a valid real-world distance');
        return;
    }

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                pixel_distance: pixelDistance,
                real_distance: realDistance
            })
        });

        const result = await response.json();
        PROJECT_DATA.pixels_per_meter = result.pixels_per_meter;
        PROJECT_DATA.scale_calibrated = true;

        // Clear calibration markers (collect-then-remove for safe iteration)
        const calibMarkers = canvas.getObjects().filter(obj => obj.calibrationMarker);
        calibMarkers.forEach(obj => canvas.remove(obj));

        calibrationPoints = [];
        hideCalibrateModal();
        setMode('pan');

        // Refresh assets with new scale
        refreshAssets();

    } catch (error) {
        console.error('Calibration error:', error);
        alert('Error applying calibration');
    }
}

function hideCalibrateModal() {
    document.getElementById('calibrateModal').style.display = 'none';
}

// Origin Setting
async function handleOriginClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                origin_x: pointer.x,
                origin_y: pointer.y
            })
        });

        const result = await response.json();
        PROJECT_DATA.origin_x = result.origin_x;
        PROJECT_DATA.origin_y = result.origin_y;

        // Draw origin marker
        drawOriginMarker(pointer.x, pointer.y);

        setMode('pan');
        refreshAssets();

    } catch (error) {
        console.error('Origin setting error:', error);
    }
}

function drawOriginMarker(x, y) {
    // Remove existing origin marker (collect-then-remove for safe iteration)
    const originMarkers = canvas.getObjects().filter(obj => obj.originMarker);
    originMarkers.forEach(obj => canvas.remove(obj));

    const marker = new fabric.Group([
        new fabric.Line([x - 20, y, x + 20, y], { stroke: '#0000FF', strokeWidth: 2 }),
        new fabric.Line([x, y - 20, x, y + 20], { stroke: '#0000FF', strokeWidth: 2 }),
        new fabric.Circle({ radius: 8, fill: 'transparent', stroke: '#0000FF', strokeWidth: 2, left: x, top: y, originX: 'center', originY: 'center' })
    ], { selectable: false, originMarker: true });

    canvas.add(marker);
    canvas.renderAll();
}

// Asset Verification / Reference Point Calibration
function toggleVerifyPanel() {
    const panel = document.getElementById('verify-panel');
    const isVisible = panel.style.display !== 'none';

    if (isVisible) {
        // Hide panel
        panel.style.display = 'none';
        setMode('pan');
        return;
    }

    if (assets.length === 0) {
        alert('No assets imported yet. Import a CSV first.');
        return;
    }

    // Show/hide scale calibration warning
    const scaleWarning = document.getElementById('verify-scale-warning');
    scaleWarning.style.display = PROJECT_DATA.scale_calibrated ? 'none' : 'block';

    // Auto-detect coordinate unit from asset values if not already set to degrees
    if (PROJECT_DATA.coord_unit === 'meters' && assets.length > 0) {
        const looksLikeDegrees = assets.every(a =>
            Math.abs(a.current_x) <= 180 && Math.abs(a.current_y) <= 90
        );
        if (looksLikeDegrees) {
            PROJECT_DATA.coord_unit = 'degrees';
            debouncedSaveAssetCalibration();
        }
    }

    // Set coord unit dropdown to current project value
    document.getElementById('verify-coord-unit').value = PROJECT_DATA.coord_unit || 'meters';

    // Populate the asset dropdown
    const select = document.getElementById('verify-asset-select');
    select.innerHTML = '<option value="">-- Select --</option>';
    assets.forEach(asset => {
        const opt = document.createElement('option');
        opt.value = asset.asset_id;
        opt.textContent = asset.asset_id + (asset.name ? ' - ' + asset.name : '');
        select.appendChild(opt);
    });

    // Pre-select current reference if set
    if (refAssetId) {
        select.value = refAssetId;
        updateVerifyRefInfo();
    }

    // Set rotation sliders to current value
    document.getElementById('verify-rotation-slider').value = assetRotationDeg;
    document.getElementById('verify-rotation-input').value = assetRotationDeg;

    // Start with collapsed list
    collapseVerifyAssetList();

    panel.style.display = 'block';
    setMode('verify-asset');
}

function filterVerifyAssetSelect(query) {
    const select = document.getElementById('verify-asset-select');
    const q = query.toLowerCase();
    let visibleCount = 0;
    for (const opt of select.options) {
        if (!opt.value) continue;
        const visible = opt.textContent.toLowerCase().includes(q);
        opt.style.display = visible ? '' : 'none';
        if (visible) visibleCount++;
    }
    // Resize to fit visible results (capped at 15 rows)
    const rows = Math.min(Math.max(visibleCount, 2), 15);
    select.size = rows;
    select.style.height = (rows * 1.6) + 'em';
}

function expandVerifyAssetList() {
    const select = document.getElementById('verify-asset-select');
    // Count visible options
    let visibleCount = 0;
    for (const opt of select.options) {
        if (!opt.value) continue;
        if (opt.style.display !== 'none') visibleCount++;
    }
    const rows = Math.min(Math.max(visibleCount, 2), 15);
    select.size = rows;
    select.style.height = (rows * 1.6) + 'em';
}

function collapseVerifyAssetList() {
    const select = document.getElementById('verify-asset-select');
    select.size = 1;
    select.style.height = '2em';
}

function onVerifyAssetSelected() {
    const select = document.getElementById('verify-asset-select');
    if (select.value) {
        collapseVerifyAssetList();
    }
    updateVerifyRefInfo();
}

function updateVerifyRefInfo() {
    const select = document.getElementById('verify-asset-select');
    const infoDiv = document.getElementById('verify-ref-info');
    const coordsSpan = document.getElementById('verify-ref-coords');
    const placedSpan = document.getElementById('verify-ref-placed');

    if (select.value) {
        const asset = assets.find(a => a.asset_id === select.value);
        if (asset) {
            infoDiv.style.display = 'block';
            coordsSpan.textContent = `(${asset.current_x.toFixed(2)}m, ${asset.current_y.toFixed(2)}m)`;
            if (refAssetId === select.value && (refPixelX !== 0 || refPixelY !== 0)) {
                placedSpan.textContent = `Reference placed at pixel (${refPixelX.toFixed(0)}, ${refPixelY.toFixed(0)})`;
                placedSpan.style.color = 'var(--border-layer-selected, #28a745)';
            } else {
                placedSpan.textContent = 'Click on the drawing to set the reference location';
                placedSpan.style.color = 'var(--text-muted, #6c757d)';
            }
        }
    } else {
        infoDiv.style.display = 'none';
    }
}

function handleVerifyClick(opt) {
    const select = document.getElementById('verify-asset-select');
    if (!select.value) {
        alert('Please select a reference asset first.');
        return;
    }

    const pointer = canvas.getPointer(opt.e);
    refAssetId = select.value;
    refPixelX = pointer.x;
    refPixelY = pointer.y;

    // Draw reference marker
    drawVerifyRefMarker(pointer.x, pointer.y);

    // Update info display
    const placedSpan = document.getElementById('verify-ref-placed');
    placedSpan.textContent = `Reference placed at pixel (${refPixelX.toFixed(0)}, ${refPixelY.toFixed(0)})`;
    placedSpan.style.color = 'var(--border-layer-selected, #28a745)';

    // Live preview: re-render assets with current rotation
    refreshAssets();
}

function drawVerifyRefMarker(x, y) {
    // Remove existing marker
    if (verifyRefMarker) {
        canvas.remove(verifyRefMarker);
    }

    // Draw a prominent crosshair/target marker
    verifyRefMarker = new fabric.Group([
        new fabric.Line([x - 15, y, x + 15, y], { stroke: '#e74c3c', strokeWidth: 2 }),
        new fabric.Line([x, y - 15, x, y + 15], { stroke: '#e74c3c', strokeWidth: 2 }),
        new fabric.Circle({ radius: 10, fill: 'transparent', stroke: '#e74c3c', strokeWidth: 2, left: x, top: y, originX: 'center', originY: 'center' }),
        new fabric.Circle({ radius: 3, fill: '#e74c3c', left: x, top: y, originX: 'center', originY: 'center' })
    ], { selectable: false, evented: false, verifyMarker: true });

    canvas.add(verifyRefMarker);
    canvas.bringToFront(verifyRefMarker);
    canvas.renderAll();
}

function onVerifyRotationChange(deg) {
    assetRotationDeg = deg;
    document.getElementById('verify-rotation-slider').value = deg;
    document.getElementById('verify-rotation-input').value = deg;
    document.getElementById('asset-rotation-slider').value = deg;
    document.getElementById('asset-rotation-input').value = deg;

    // Live preview if reference is set
    if (refAssetId && (refPixelX !== 0 || refPixelY !== 0)) {
        refreshAssets();
    }
}

function setAssetRotation(deg) {
    assetRotationDeg = deg;
    document.getElementById('asset-rotation-slider').value = deg;
    document.getElementById('asset-rotation-input').value = deg;
    document.getElementById('verify-rotation-slider').value = deg;
    document.getElementById('verify-rotation-input').value = deg;

    // Live preview if reference is set
    if (refAssetId) {
        refreshAssets();
    }

    // Debounced save
    debouncedSaveAssetCalibration();
}

let assetCalibrationSaveTimeout = null;
function debouncedSaveAssetCalibration() {
    if (assetCalibrationSaveTimeout) {
        clearTimeout(assetCalibrationSaveTimeout);
    }
    assetCalibrationSaveTimeout = setTimeout(saveAssetCalibration, 500);
}

async function saveAssetCalibration() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                asset_rotation: assetRotationDeg,
                ref_asset_id: refAssetId,
                ref_pixel_x: refPixelX,
                ref_pixel_y: refPixelY,
                coord_unit: PROJECT_DATA.coord_unit
            })
        });

        if (response.ok) {
            const result = await response.json();
            PROJECT_DATA.asset_rotation = result.asset_rotation;
            PROJECT_DATA.ref_asset_id = result.ref_asset_id;
            PROJECT_DATA.ref_pixel_x = result.ref_pixel_x;
            PROJECT_DATA.ref_pixel_y = result.ref_pixel_y;
            PROJECT_DATA.coord_unit = result.coord_unit;
            console.log('Asset calibration saved');
        }
    } catch (error) {
        console.error('Error saving asset calibration:', error);
    }
}

function onCoordUnitChange(value) {
    PROJECT_DATA.coord_unit = value;
    // Live preview if reference is set
    if (refAssetId && (refPixelX !== 0 || refPixelY !== 0)) {
        refreshAssets();
    }
    // Debounced save
    debouncedSaveAssetCalibration();
}

async function applyVerification() {
    const select = document.getElementById('verify-asset-select');
    if (!select.value) {
        alert('Please select a reference asset.');
        return;
    }

    if (refPixelX === 0 && refPixelY === 0) {
        alert('Please click on the drawing to set the reference location.');
        return;
    }

    refAssetId = select.value;

    // Save to server
    await saveAssetCalibration();

    // Close panel and refresh
    document.getElementById('verify-panel').style.display = 'none';
    setMode('pan');
    refreshAssets();

    // Keep the marker visible (don't remove it)
    console.log('Asset verification applied: ref=' + refAssetId +
        ', pixel=(' + refPixelX.toFixed(0) + ',' + refPixelY.toFixed(0) + ')' +
        ', rotation=' + assetRotationDeg + '°');
}

// Asset Position Updates
/**
 * Convert pixel coordinates back to asset coordinates (inverse of assetMeterToPixel).
 * Handles both meter and degree (lat/lon) coordinate systems.
 */
function pixelToAssetMeter(pixelX, pixelY) {
    const ppm = PROJECT_DATA.pixels_per_meter;
    if (!ppm || !isFinite(ppm) || ppm <= 0) {
        console.warn('pixelToAssetMeter: invalid pixels_per_meter:', ppm);
        return { x: 0, y: 0 };
    }

    if (refAssetId) {
        const refAsset = assets.find(a => a.asset_id === refAssetId);
        if (refAsset) {
            const dpx = pixelX - refPixelX;
            const dpy = pixelY - refPixelY;

            // Inverse rotation (pixel space → meter space)
            const rad = -assetRotationDeg * Math.PI / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const rotDpx = dpx * cos - dpy * sin;
            const rotDpy = dpx * sin + dpy * cos;

            // Pixel offset to meter offset
            const dmx = rotDpx / ppm;
            const dmy = rotDpy / ppm;

            // Convert meter offset back to coordinate offset (handles meter→degree if needed)
            const dCoord = metersToCoordOffset(dmx, dmy, refAsset.current_y);

            return {
                x: refAsset.current_x + dCoord.x,
                y: refAsset.current_y + dCoord.y
            };
        }
    }
    // Fallback: origin-based inverse
    const mx = (pixelX - PROJECT_DATA.origin_x) / ppm;
    const my = (pixelY - PROJECT_DATA.origin_y) / ppm;
    const coord = metersToCoordOffset(mx, my, 0);
    return { x: coord.x, y: coord.y };
}

// -------------------------------------------------------------------------
// Measurement Tool
// -------------------------------------------------------------------------

function calcMeasureDistance(p1, p2) {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const pixelDist = Math.sqrt(dx * dx + dy * dy);
    const ppm = PROJECT_DATA.pixels_per_meter;
    if (PROJECT_DATA.scale_calibrated && ppm && isFinite(ppm) && ppm > 0) {
        return { pixels: pixelDist, meters: pixelDist / ppm, calibrated: true };
    }
    return { pixels: pixelDist, meters: null, calibrated: false };
}

function formatMeasureDistance(dist) {
    if (dist.calibrated) {
        if (dist.meters >= 1000) return `${(dist.meters / 1000).toFixed(2)} km`;
        if (dist.meters >= 1) return `${dist.meters.toFixed(2)} m`;
        return `${(dist.meters * 100).toFixed(1)} cm`;
    }
    return `${Math.round(dist.pixels)} px`;
}

/**
 * Bring all measurements (active and saved) to the front of the canvas.
 * This ensures they're always visible above other layers.
 */
function bringMeasurementsToFront() {
    const measurements = canvas.getObjects().filter(obj => 
        obj.isMeasurement || obj.isMeasurementGroup || obj.isSavedMeasurement
    );
    measurements.forEach(m => canvas.bringToFront(m));
}

function removeMeasurePreview() {
    if (measurePreviewLine) { canvas.remove(measurePreviewLine); measurePreviewLine = null; }
    if (measurePreviewLabel) { canvas.remove(measurePreviewLabel); measurePreviewLabel = null; }
}

function clearMeasurements() {
    MeasurementTool.clearCurrent();
    measureOverlays.forEach(obj => canvas.remove(obj));
    measureOverlays = [];
    removeMeasurePreview();
    measurePoints = [];
    updateMeasurePanel();
    canvas.renderAll();
}

function toggleMeasureMode(mode) {
    measureMode = mode;
    MeasurementTool.startMeasurement(mode);
    clearMeasurements();
}

function toggleMeasurePanel() {
    const section = document.getElementById('measure-section');
    const isVisible = section && section.style.display !== 'none';
    if (isVisible) {
        if (section) section.style.display = 'none';
        clearMeasurements();
        MeasurementTool.clearCurrent();
        setMode('pan');
        return;
    }
    if (section) section.style.display = 'block';
    MeasurementTool.startMeasurement(measureMode);
    setMode('measure');
}

function handleMeasureClick(opt) {
    const pointer = canvas.getPointer(opt.e);
    MeasurementTool.addPoint(pointer.x, pointer.y);
}

function handleMeasureMove(opt) {
    if (measurePoints.length === 0) return;
    if (measureMode === 'single' && measurePoints.length >= 2) return;

    const pointer = canvas.getPointer(opt.e);
    const lastPt = measurePoints[measurePoints.length - 1];

    // Update or create preview line
    if (!measurePreviewLine) {
        measurePreviewLine = new fabric.Line(
            [lastPt.x, lastPt.y, pointer.x, pointer.y],
            { stroke: '#00bcd4', strokeWidth: 1, strokeUniform: true,
              strokeDashArray: [4, 4], opacity: 0.6, selectable: false, evented: false,
              isMeasurement: true }  // Mark as measurement
        );
        canvas.add(measurePreviewLine);
    } else {
        measurePreviewLine.set({ x1: lastPt.x, y1: lastPt.y, x2: pointer.x, y2: pointer.y });
    }
    canvas.bringToFront(measurePreviewLine);

    // Update or create preview label
    const dist = calcMeasureDistance(lastPt, pointer);
    const label = formatMeasureDistance(dist);
    const midX = (lastPt.x + pointer.x) / 2;
    const midY = (lastPt.y + pointer.y) / 2;
    if (!measurePreviewLabel) {
        measurePreviewLabel = new fabric.Text(label, {
            left: midX, top: midY - 18, fontSize: 11, fill: '#ffffff',
            backgroundColor: 'rgba(0, 188, 212, 0.5)', fontFamily: 'monospace',
            padding: 3, selectable: false, evented: false,
            isMeasurement: true  // Mark as measurement
        });
        canvas.add(measurePreviewLabel);
    } else {
        measurePreviewLabel.set({ text: label, left: midX, top: midY - 18 });
    }
    canvas.bringToFront(measurePreviewLabel);
    canvas.renderAll();
}

function updateMeasurePanel() {
    const segmentList = document.getElementById('measure-segments');
    const totalEl = document.getElementById('measure-total');
    const straightEl = document.getElementById('measure-straight');
    const straightRow = document.getElementById('measure-straight-row');
    const warningEl = document.getElementById('measure-scale-warning');

    if (!segmentList) return;

    if (warningEl) {
        warningEl.style.display = PROJECT_DATA.scale_calibrated ? 'none' : 'block';
    }

    segmentList.innerHTML = '';

    if (measurePoints.length < 2) {
        totalEl.textContent = '--';
        straightEl.textContent = '--';
        straightRow.style.display = 'none';
        return;
    }

    let totalPixels = 0;
    let totalMeters = 0;
    let allCalibrated = true;

    for (let i = 1; i < measurePoints.length; i++) {
        const dist = calcMeasureDistance(measurePoints[i - 1], measurePoints[i]);
        totalPixels += dist.pixels;
        if (dist.calibrated) { totalMeters += dist.meters; } else { allCalibrated = false; }

        const li = document.createElement('div');
        li.style.cssText = 'padding: 0.2rem 0; font-size: 0.8rem; border-bottom: 1px solid var(--border-light, #e0e0e0); display: flex; justify-content: space-between;';
        li.innerHTML = `<span>Seg ${i}</span><span>${formatMeasureDistance(dist)}</span>`;
        segmentList.appendChild(li);
    }

    const totalDist = allCalibrated
        ? { pixels: totalPixels, meters: totalMeters, calibrated: true }
        : { pixels: totalPixels, meters: null, calibrated: false };
    totalEl.textContent = formatMeasureDistance(totalDist);

    // Straight-line distance (chain mode with 3+ points)
    if (measureMode === 'chain' && measurePoints.length >= 3) {
        straightRow.style.display = 'flex';
        const straightDist = calcMeasureDistance(measurePoints[0], measurePoints[measurePoints.length - 1]);
        straightEl.textContent = formatMeasureDistance(straightDist);
    } else {
        straightRow.style.display = 'none';
    }
}

function updateAssetPositionFromCanvas(obj) {
    if (!obj.assetData) return;

    // Convert pixel position back to meters
    const pos = pixelToAssetMeter(obj.left, obj.top);

    // Update the property panel if this asset is selected
    if (selectedAsset && selectedAsset.id === obj.assetData.id) {
        document.getElementById('asset-adj-x').value = pos.x.toFixed(3);
        document.getElementById('asset-adj-y').value = pos.y.toFixed(3);
    }
}

async function saveAssetAdjustment() {
    if (!selectedAsset) return;

    const newX = parseFloat(document.getElementById('asset-adj-x').value);
    const newY = parseFloat(document.getElementById('asset-adj-y').value);
    const notes = document.getElementById('asset-notes').value;

    try {
        const response = await fetch(`/api/assets/${selectedAsset.id}/adjust/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ x: newX, y: newY, notes: notes })
        });

        if (response.ok) {
            const updated = await response.json();
            // Update local data
            const index = assets.findIndex(a => a.id === selectedAsset.id);
            assets[index] = updated;
            selectedAsset = updated;

            renderAssetList();
            refreshAssets();
            alert('Asset adjustment saved');
        }
    } catch (error) {
        console.error('Error saving adjustment:', error);
        alert('Error saving adjustment');
    }
}

// Sheet Position Updates
function updateSheetPositionFromCanvas(obj) {
    if (!obj.sheetData) return;

    // Auto-save position changes using the object's sheet data directly
    const sheetId = obj.sheetData.id;
    saveSheetPosition(sheetId, obj.left, obj.top);
}

function updateSheetRotationFromCanvas(obj) {
    if (!obj.sheetData) return;

    const sheetId = obj.sheetData.id;
    const rotation = obj.angle;

    // Update local data
    const index = sheets.findIndex(s => s.id === sheetId);
    if (index >= 0) {
        sheets[index].rotation = rotation;
    }

    // Update properties panel if this sheet is selected
    if (selectedSheet && selectedSheet.id === sheetId) {
        selectedSheet.rotation = rotation;
        document.getElementById('sheet-rotation').value = rotation.toFixed(1);
    }

    // Save to server
    saveSheetRotation(sheetId, rotation);
}

async function saveSheetRotation(sheetId, rotation) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ rotation: rotation })
        });

        if (!response.ok) {
            console.error('Error saving sheet rotation:', await response.text());
        } else {
            console.log('Sheet rotation saved:', rotation);
        }
    } catch (error) {
        console.error('Error saving sheet rotation:', error);
    }
}

async function saveSheetPosition(sheetId, x, y) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ offset_x: x, offset_y: y })
        });

        if (response.ok) {
            const updated = await response.json();
            const index = sheets.findIndex(s => s.id === sheetId);
            if (index >= 0) {
                sheets[index] = updated;
                if (selectedSheet && selectedSheet.id === sheetId) {
                    selectedSheet = updated;
                    document.getElementById('sheet-offset-x').value = updated.offset_x;
                    document.getElementById('sheet-offset-y').value = updated.offset_y;
                }
            }
        }
    } catch (error) {
        console.error('Error saving sheet position:', error);
    }
}

async function updateSheetProperty(property, value, reload = true) {
    if (!selectedSheet) return;

    const data = {};
    data[property] = value;

    try {
        const response = await fetch(`/api/sheets/${selectedSheet.id}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify(data)
        });

        if (response.ok && reload) {
            const updated = await response.json();
            const index = sheets.findIndex(s => s.id === selectedSheet.id);
            sheets[index] = updated;
            selectedSheet = updated;

            // Update the canvas object visually
            updateSheetOnCanvas(selectedSheet.id, property, value);
        }
    } catch (error) {
        console.error('Error updating sheet:', error);
    }
}

function updateSheetOnCanvas(sheetId, property, value) {
    // Find the sheet object on canvas and update its visual property
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            switch (property) {
                case 'rotation':
                    obj.set('angle', parseFloat(value));
                    break;
                case 'offset_x':
                    obj.set('left', parseFloat(value));
                    break;
                case 'offset_y':
                    obj.set('top', parseFloat(value));
                    break;
                case 'z_index':
                    // Re-order layers based on z_index
                    // Higher z_index = more to front
                    const zIndex = parseInt(value);
                    if (zIndex > 0) {
                        canvas.bringToFront(obj);
                    } else {
                        canvas.sendToBack(obj);
                    }
                    break;
            }
            obj.setCoords();  // Update object coordinates after transformation
            canvas.renderAll();
        }
    });
}

// Refresh Functions
function refreshAssets() {
    // Collect-then-remove to avoid mutation-during-iteration
    const toRemove = canvas.getObjects().filter(obj => obj.assetData);
    toRemove.forEach(obj => canvas.remove(obj));

    // Re-render
    renderAssetsOnCanvas();
}

function toggleSheetVisibility(sheetId, visible) {
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            obj.visible = visible;
        }
    });
    canvas.renderAll();
}

/**
 * Toggle visibility of a single asset
 */
function toggleAssetVisibility(assetId, visible) {
    // Update in local data
    const asset = assets.find(a => a.id === assetId);
    if (asset) {
        asset.visible = visible;
    }
    // Update on canvas
    canvas.getObjects().forEach(obj => {
        if (obj.assetData && obj.assetData.id === assetId) {
            obj.visible = visible;
        }
    });
    canvas.renderAll();
}

/**
 * Toggle visibility of a single link
 */
function toggleLinkVisibility(linkId, visible) {
    // Update in local data
    const link = links.find(l => l.id === linkId);
    if (link) {
        link.visible = visible;
    }
    // Update on canvas
    canvas.getObjects().forEach(obj => {
        if (obj.linkData && obj.linkData.id === linkId) {
            obj.visible = visible;
        }
    });
    canvas.renderAll();
}

function toggleLayerGroup(groupName) {
    const body = document.getElementById(groupName + '-group-body');
    const chevron = document.getElementById(groupName + '-chevron');
    if (body) body.classList.toggle('collapsed');
    if (chevron) chevron.classList.toggle('collapsed');
}

function toggleGroupVisibility(groupName, visible) {
    if (groupName === 'sheets') {
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) obj.visible = visible;
        });
        // Sync individual checkboxes
        document.querySelectorAll('#sheet-layers .layer-visibility').forEach(cb => {
            cb.checked = visible;
        });
    } else if (groupName === 'assets') {
        canvas.getObjects().forEach(obj => {
            if (obj.assetData) obj.visible = visible;
        });
        // Sync batch checkboxes
        document.querySelectorAll('#import-batches .batch-visibility').forEach(cb => {
            cb.checked = visible;
        });
    } else if (groupName === 'links') {
        canvas.getObjects().forEach(obj => {
            if (obj.isLinkObject) obj.visible = visible;
        });
    } else if (groupName === 'measurements') {
        // Toggle all measurement objects
        canvas.getObjects().forEach(obj => {
            if (obj.measurementData || obj.isMeasurement) obj.visible = visible;
        });
    } else if (groupName === 'unified') {
        // Toggle all objects (sheets, assets, links, measurements)
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData || obj.assetData || obj.isLinkObject || obj.measurementData || obj.isMeasurement) {
                obj.visible = visible;
            }
        });
    }
    canvas.renderAll();
}

function toggleBatchVisibility(batchId, visible) {
    canvas.getObjects().forEach(obj => {
        if (obj.assetData && obj.assetData.import_batch === batchId) {
            obj.visible = visible;
        }
    });
    canvas.renderAll();
}

// Zoom Controls
function zoomIn() {
    let zoom = currentZoomLevel * 1.2;
    if (zoom > 5) zoom = 5;
    setZoomPreservingRotation(zoom);
    updateZoomDisplay();
}

function zoomOut() {
    let zoom = currentZoomLevel / 1.2;
    if (zoom < 0.1) zoom = 0.1;
    setZoomPreservingRotation(zoom);
    updateZoomDisplay();
}

/**
 * Set zoom while preserving the current viewport rotation
 * @param {number} zoom - New zoom level
 */
function setZoomPreservingRotation(zoom) {
    currentZoomLevel = zoom;
    const angleRad = viewportRotation * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const vpt = canvas.viewportTransform;

    // Apply zoom with rotation
    vpt[0] = cos * zoom;
    vpt[1] = sin * zoom;
    vpt[2] = -sin * zoom;
    vpt[3] = cos * zoom;
    // Keep pan values unchanged

    canvas.setViewportTransform(vpt);

    canvas.forEachObject(function(obj) {
        obj.setCoords();
    });
}

function zoomFit() {
    // Calculate bounds of all objects
    const objects = canvas.getObjects().filter(obj => obj.sheetData);
    if (objects.length === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objects.forEach(obj => {
        const bounds = obj.getBoundingRect();
        minX = Math.min(minX, bounds.left);
        minY = Math.min(minY, bounds.top);
        maxX = Math.max(maxX, bounds.left + bounds.width);
        maxY = Math.max(maxY, bounds.top + bounds.height);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    // Guard against zero-dimension content (all objects at same point)
    if (contentWidth < 1 || contentHeight < 1) {
        setZoomPreservingRotation(1);
        canvas.absolutePan({ x: 0, y: 0 });
        applyViewportRotation();
        updateZoomDisplay();
        return;
    }

    const zoomX = canvas.width / contentWidth * 0.9;
    const zoomY = canvas.height / contentHeight * 0.9;
    const zoom = Math.min(zoomX, zoomY, 1);

    setZoomPreservingRotation(zoom);
    canvas.absolutePan({
        x: minX * zoom - (canvas.width - contentWidth * zoom) / 2,
        y: minY * zoom - (canvas.height - contentHeight * zoom) / 2
    });
    applyViewportRotation();

    updateZoomDisplay();
}

/**
 * Bring to Scale - Zoom to fit all sheets while respecting real-world scale
 * Similar to zoomFit but considers scale calibration for more accurate view
 */
function bringToScale() {
    // Calculate bounds of all sheet objects
    const objects = canvas.getObjects().filter(obj => obj.sheetData);
    if (objects.length === 0) {
        alert('No sheets to display');
        return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    objects.forEach(obj => {
        const bounds = obj.getBoundingRect();
        minX = Math.min(minX, bounds.left);
        minY = Math.min(minY, bounds.top);
        maxX = Math.max(maxX, bounds.left + bounds.width);
        maxY = Math.max(maxY, bounds.top + bounds.height);
    });

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    // Guard against zero-dimension content
    if (contentWidth < 1 || contentHeight < 1) {
        setZoomPreservingRotation(1);
        canvas.absolutePan({ x: 0, y: 0 });
        applyViewportRotation();
        updateZoomDisplay();
        return;
    }

    // Calculate optimal zoom to fit content with padding
    const zoomX = canvas.width / contentWidth * 0.85;
    const zoomY = canvas.height / contentHeight * 0.85;
    let zoom = Math.min(zoomX, zoomY);

    // Cap zoom at 2x for usability (don't zoom in too much)
    zoom = Math.min(zoom, 2);

    setZoomPreservingRotation(zoom);

    // Center the content in the viewport
    canvas.absolutePan({
        x: minX * zoom - (canvas.width - contentWidth * zoom) / 2,
        y: minY * zoom - (canvas.height - contentHeight * zoom) / 2
    });

    applyViewportRotation();
    updateZoomDisplay();
    debouncedSaveViewportState();

    console.log('Brought to scale: zoom =', zoom.toFixed(2));
}

function resetView() {
    setZoomPreservingRotation(1);
    canvas.absolutePan({ x: 0, y: 0 });
    applyViewportRotation();  // Re-apply rotation after pan
    updateZoomDisplay();
    debouncedSaveViewportState();
}

function updateZoomDisplay() {
    const zoom = Math.round(currentZoomLevel * 100);
    document.getElementById('zoom-level').textContent = zoom;
    document.getElementById('zoom-display').textContent = zoom + '%';
}

// Viewport State Persistence Functions
let viewportSaveTimeout = null;

/**
 * Save the current viewport state (zoom, pan, rotation) to localStorage
 */
function saveViewportState() {
    if (!canvas || typeof PROJECT_ID === 'undefined') return;
    
    const vpt = canvas.viewportTransform;
    const state = {
        zoom: currentZoomLevel,
        panX: vpt[4],
        panY: vpt[5],
        rotation: viewportRotation,
        timestamp: Date.now()
    };
    
    const key = `docuweaver-viewport-${PROJECT_ID}`;
    localStorage.setItem(key, JSON.stringify(state));
}

/**
 * Restore the saved viewport state (zoom and pan) from localStorage
 * @returns {boolean} True if state was successfully restored
 */
function restoreViewportState() {
    if (!canvas || typeof PROJECT_ID === 'undefined') {
        console.log('Cannot restore viewport: canvas or PROJECT_ID not available');
        return false;
    }
    
    const key = `docuweaver-viewport-${PROJECT_ID}`;
    const saved = localStorage.getItem(key);
    
    console.log('Attempting to restore viewport for project:', PROJECT_ID);
    
    if (saved) {
        try {
            const state = JSON.parse(saved);
            if (state.zoom && state.panX !== undefined && state.panY !== undefined) {
                currentZoomLevel = state.zoom;
                
                // Apply the saved viewport transform
                const angleRad = (state.rotation || viewportRotation || 0) * Math.PI / 180;
                const cos = Math.cos(angleRad);
                const sin = Math.sin(angleRad);
                
                const vpt = canvas.viewportTransform;
                vpt[0] = cos * currentZoomLevel;
                vpt[1] = sin * currentZoomLevel;
                vpt[2] = -sin * currentZoomLevel;
                vpt[3] = cos * currentZoomLevel;
                vpt[4] = state.panX;
                vpt[5] = state.panY;
                
                // Restore rotation if saved
                if (state.rotation !== undefined) {
                    viewportRotation = state.rotation;
                }
                
                canvas.setViewportTransform(vpt);
                canvas.forEachObject(function(obj) { obj.setCoords(); });
                canvas.requestRenderAll();
                updateZoomDisplay();
                updateRotationDisplay();
                
                console.log('Successfully restored viewport state:', state);
                return true;
            } else {
                console.log('Invalid state structure:', state);
            }
        } catch (e) {
            console.error('Failed to restore viewport state:', e);
        }
    } else {
        console.log('No saved viewport state found for project:', PROJECT_ID);
    }
    return false;
}

/**
 * Debounced save to avoid excessive localStorage writes
 */
function debouncedSaveViewportState() {
    if (viewportSaveTimeout) {
        clearTimeout(viewportSaveTimeout);
    }
    viewportSaveTimeout = setTimeout(saveViewportState, 300);
}

// Viewport Rotation Functions
let rotationSaveTimeout = null;

/**
 * Set the viewport rotation to a specific angle
 * @param {number} degrees - Rotation angle in degrees
 */
function setViewportRotation(degrees) {
    viewportRotation = ((degrees % 360) + 360) % 360;  // Normalize to 0-360
    applyViewportRotation();
    updateRotationDisplay();
    debouncedSaveRotation();
}

/**
 * Rotate the viewport by a delta amount
 * @param {number} delta - Degrees to rotate by (positive = clockwise)
 */
function rotateViewportBy(delta) {
    setViewportRotation(viewportRotation + delta);
}

/**
 * Rotate the view to match the selected sheet's rotation angle
 */
function matchSheetRotation() {
    if (!selectedSheet) {
        alert('Please select a sheet first');
        return;
    }
    setViewportRotation(-selectedSheet.rotation);
    console.log('View rotated to match sheet:', selectedSheet.name, -selectedSheet.rotation);
}

/**
 * Reset the viewport rotation to 0 degrees
 */
function resetViewportRotation() {
    setViewportRotation(0);
}

/**
 * Apply the current viewport rotation to the canvas
 */
function applyViewportRotation() {
    const angleRad = viewportRotation * Math.PI / 180;
    const cos = Math.cos(angleRad);
    const sin = Math.sin(angleRad);

    const vpt = canvas.viewportTransform;
    const currentZoom = currentZoomLevel;

    // Get current pan position
    const panX = vpt[4];
    const panY = vpt[5];

    // Apply rotation with current zoom
    // Matrix: [scaleX*cos, scaleY*sin, -scaleX*sin, scaleY*cos, panX, panY]
    vpt[0] = cos * currentZoom;
    vpt[1] = sin * currentZoom;
    vpt[2] = -sin * currentZoom;
    vpt[3] = cos * currentZoom;
    // Keep pan values
    vpt[4] = panX;
    vpt[5] = panY;

    canvas.setViewportTransform(vpt);

    // Update all object coordinates so selection borders, controls,
    // and hit-testing align with the new viewport transform
    canvas.forEachObject(function(obj) {
        obj.setCoords();
    });

    // Render all objects without any culling (our custom _renderObjects override handles this)
    canvas.renderAll();
    
    // Refresh OSM tiles for new viewport (handles rotation correctly with 4-corner bounds)
    debouncedRefreshOSM();
}

/**
 * Update the rotation display in the UI
 */
function updateRotationDisplay() {
    const displayAngle = Math.round(viewportRotation);
    document.getElementById('rotation-level').textContent = displayAngle;
    const rotationInput = document.getElementById('viewport-rotation');
    if (rotationInput) {
        rotationInput.value = displayAngle;
    }
}

/**
 * Save viewport rotation to server (debounced)
 */
function debouncedSaveRotation() {
    if (rotationSaveTimeout) {
        clearTimeout(rotationSaveTimeout);
    }
    rotationSaveTimeout = setTimeout(saveViewportRotation, 500);
}

async function saveViewportRotation() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/calibrate/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ canvas_rotation: viewportRotation })
        });

        if (response.ok) {
            const result = await response.json();
            PROJECT_DATA.canvas_rotation = result.canvas_rotation;
            console.log('Viewport rotation saved:', viewportRotation);
        }
    } catch (error) {
        console.error('Error saving viewport rotation:', error);
    }
}

function updateCursorPosition(opt) {
    const cursorEl = document.getElementById('cursor-position');
    if (!cursorEl) return;  // Element doesn't exist, skip update
    
    const pointer = canvas.getPointer(opt.e);
    const ppm = PROJECT_DATA.pixels_per_meter;
    
    // If scale not calibrated, show pixel coordinates
    if (!ppm || !isFinite(ppm) || ppm <= 0) {
        cursorEl.textContent = `${Math.round(pointer.x)}px, ${Math.round(pointer.y)}px`;
        return;
    }
    
    const pos = pixelToAssetMeter(pointer.x, pointer.y);
    cursorEl.textContent = `${pos.x.toFixed(2)}m, ${pos.y.toFixed(2)}m`;
}

// Tab Switching
function showTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.toggle('active', content.id === tabName + '-tab');
    });
}

// Modal Functions
function showUploadModal() {
    document.getElementById('uploadModal').style.display = 'block';
}

function hideUploadModal() {
    document.getElementById('uploadModal').style.display = 'none';
}

// CSV Import — Two-step flow
let importCsvFile = null;      // The selected CSV File object
let importCsvHeaders = [];     // Parsed column headers
let importColumnPresets = {};  // Admin-configured presets

function showImportModal() {
    // Reset to step 1
    document.getElementById('import-step-1').style.display = 'block';
    document.getElementById('import-step-2').style.display = 'none';
    document.getElementById('import-csv-file').value = '';
    importCsvFile = null;
    importCsvHeaders = [];
    document.getElementById('importModal').style.display = 'block';
}

function hideImportModal() {
    document.getElementById('importModal').style.display = 'none';
}

async function importStepNext() {
    const fileInput = document.getElementById('import-csv-file');
    if (!fileInput.files.length) {
        alert('Please select a CSV file.');
        return;
    }

    importCsvFile = fileInput.files[0];

    // Parse CSV headers client-side
    try {
        const text = await importCsvFile.text();
        const firstLine = text.split('\n')[0].trim();
        // Handle quoted headers
        importCsvHeaders = firstLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        if (importCsvHeaders.length === 0) {
            alert('Could not parse CSV headers.');
            return;
        }
    } catch (err) {
        alert('Error reading CSV file: ' + err.message);
        return;
    }

    // Fetch presets from admin
    try {
        const resp = await fetch('/api/column-presets/');
        if (resp.ok) {
            importColumnPresets = await resp.json();
        }
    } catch (err) {
        console.error('Could not fetch column presets:', err);
        importColumnPresets = {};
    }

    // Show preview of detected columns
    const preview = document.getElementById('import-csv-preview');
    preview.textContent = 'Detected columns: ' + importCsvHeaders.join(', ');

    // Check localStorage for remembered mapping for these headers
    const mappingKey = 'csvMapping_' + [...importCsvHeaders].sort().join('|');
    let rememberedMapping = null;
    try {
        const saved = localStorage.getItem(mappingKey);
        if (saved) rememberedMapping = JSON.parse(saved);
    } catch (e) { /* ignore */ }

    // Populate dropdowns
    const roles = [
        { id: 'map-asset-id', role: 'asset_id', required: true },
        { id: 'map-asset-type', role: 'asset_type', required: true },
        { id: 'map-x', role: 'x', required: true },
        { id: 'map-y', role: 'y', required: true },
        { id: 'map-name', role: 'name', required: false },
    ];

    roles.forEach(({ id, role, required }) => {
        const select = document.getElementById(id);
        select.innerHTML = '';

        if (!required) {
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '-- None --';
            select.appendChild(noneOpt);
        }

        importCsvHeaders.forEach(header => {
            const opt = document.createElement('option');
            opt.value = header;
            opt.textContent = header;
            select.appendChild(opt);
        });

        // Priority 1: Use remembered mapping from localStorage
        let matched = false;
        if (rememberedMapping && rememberedMapping[role] && importCsvHeaders.includes(rememberedMapping[role])) {
            select.value = rememberedMapping[role];
            matched = true;
        }

        // Priority 2: Check admin presets (ordered by priority from API)
        if (!matched) {
            const presetNames = importColumnPresets[role] || [];
            for (const presetName of presetNames) {
                const match = importCsvHeaders.find(h => h.toLowerCase() === presetName.toLowerCase());
                if (match) {
                    select.value = match;
                    matched = true;
                    break;
                }
            }
        }

        // Priority 3: Fallback to case-insensitive match on role name
        if (!matched) {
            const fallback = importCsvHeaders.find(h => h.toLowerCase() === role.toLowerCase());
            if (fallback) {
                select.value = fallback;
            }
        }
    });

    // Restore asset type mode from remembered mapping
    if (rememberedMapping && rememberedMapping._assetTypeMode) {
        const radio = document.querySelector(`input[name="asset-type-mode"][value="${rememberedMapping._assetTypeMode}"]`);
        if (radio) radio.checked = true;
        if (rememberedMapping._assetTypeMode === 'fixed' && rememberedMapping._fixedAssetType) {
            document.getElementById('fixed-asset-type').value = rememberedMapping._fixedAssetType;
        }
    } else {
        // Default to column mode
        document.querySelector('input[name="asset-type-mode"][value="column"]').checked = true;
    }
    toggleAssetTypeMode();

    if (rememberedMapping) {
        preview.textContent += ' (using remembered mapping)';
    }

    // Switch to step 2
    document.getElementById('import-step-1').style.display = 'none';
    document.getElementById('import-step-2').style.display = 'block';
}

function toggleAssetTypeMode() {
    const mode = document.querySelector('input[name="asset-type-mode"]:checked').value;
    document.getElementById('map-asset-type').style.display = mode === 'column' ? '' : 'none';
    document.getElementById('fixed-asset-type').style.display = mode === 'fixed' ? '' : 'none';
}

function importStepBack() {
    document.getElementById('import-step-2').style.display = 'none';
    document.getElementById('import-step-1').style.display = 'block';
}

async function importWithMapping() {
    if (!importCsvFile) {
        alert('No CSV file selected.');
        return;
    }

    const assetTypeMode = document.querySelector('input[name="asset-type-mode"]:checked').value;

    const mapping = {
        asset_id: document.getElementById('map-asset-id').value,
        x: document.getElementById('map-x').value,
        y: document.getElementById('map-y').value,
    };

    if (assetTypeMode === 'column') {
        mapping.asset_type = document.getElementById('map-asset-type').value;
    }

    // Validate required fields are selected
    for (const [role, col] of Object.entries(mapping)) {
        if (!col) {
            alert(`Please select a column for "${role}".`);
            return;
        }
    }

    const nameCol = document.getElementById('map-name').value;
    if (nameCol) {
        mapping.name = nameCol;
    }

    const formData = new FormData();
    formData.append('file', importCsvFile);
    formData.append('column_mapping', JSON.stringify(mapping));

    if (assetTypeMode === 'fixed') {
        formData.append('fixed_asset_type', document.getElementById('fixed-asset-type').value);
    }

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/import-csv/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            body: formData
        });

        const result = await response.json();
        if (response.ok) {
            // Save column mapping to localStorage for future imports with same headers
            try {
                const mappingKey = 'csvMapping_' + [...importCsvHeaders].sort().join('|');
                const saveData = { ...mapping, _assetTypeMode: assetTypeMode };
                if (assetTypeMode === 'fixed') {
                    saveData._fixedAssetType = document.getElementById('fixed-asset-type').value;
                }
                localStorage.setItem(mappingKey, JSON.stringify(saveData));
            } catch (e) { /* ignore storage errors */ }

            alert(`Import complete:\n${result.created} created\n${result.updated} updated\n${result.errors.length} errors`);
            hideImportModal();
            loadProjectData();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Import error:', error);
    }
}

// Link CSV Import — Two-step flow
let importLinksCsvFile = null;
let importLinksCsvHeaders = [];

function showImportLinksModal() {
    // Reset to step 1
    document.getElementById('import-links-step-1').style.display = 'block';
    document.getElementById('import-links-step-2').style.display = 'none';
    document.getElementById('import-links-csv-file').value = '';
    importLinksCsvFile = null;
    importLinksCsvHeaders = [];
    document.getElementById('importLinksModal').style.display = 'block';
}

function hideImportLinksModal() {
    document.getElementById('importLinksModal').style.display = 'none';
}

async function importLinksStepNext() {
    const fileInput = document.getElementById('import-links-csv-file');
    if (!fileInput.files.length) {
        alert('Please select a CSV file.');
        return;
    }

    importLinksCsvFile = fileInput.files[0];

    // Parse CSV headers client-side
    try {
        const text = await importLinksCsvFile.text();
        const firstLine = text.split('\n')[0].trim();
        importLinksCsvHeaders = firstLine.split(',').map(h => h.trim().replace(/^["']|["']$/g, ''));

        if (importLinksCsvHeaders.length === 0) {
            alert('Could not parse CSV headers.');
            return;
        }
    } catch (err) {
        alert('Error reading CSV file: ' + err.message);
        return;
    }

    // Show preview of detected columns
    const preview = document.getElementById('import-links-csv-preview');
    preview.textContent = 'Detected columns: ' + importLinksCsvHeaders.join(', ');

    // Populate dropdowns
    const roles = [
        { id: 'map-link-id', role: 'link_id', required: true },
        { id: 'map-coordinates', role: 'coordinates', required: true },
        { id: 'map-link-name', role: 'name', required: false },
        { id: 'map-link-type', role: 'link_type', required: false },
    ];

    roles.forEach(({ id, role, required }) => {
        const select = document.getElementById(id);
        select.innerHTML = '';

        if (!required) {
            const noneOpt = document.createElement('option');
            noneOpt.value = '';
            noneOpt.textContent = '-- None --';
            select.appendChild(noneOpt);
        }

        importLinksCsvHeaders.forEach(header => {
            const opt = document.createElement('option');
            opt.value = header;
            opt.textContent = header;
            select.appendChild(opt);
        });

        // Auto-match by name
        const match = importLinksCsvHeaders.find(h => 
            h.toLowerCase().includes(role.toLowerCase()) ||
            h.toLowerCase() === role.toLowerCase() ||
            (role === 'link_id' && (h.toLowerCase().includes('id') || h.toLowerCase().includes('link'))) ||
            (role === 'coordinates' && (h.toLowerCase().includes('coord') || h.toLowerCase().includes('geom')))
        );
        if (match) {
            select.value = match;
        }
    });

    // Switch to step 2
    document.getElementById('import-links-step-1').style.display = 'none';
    document.getElementById('import-links-step-2').style.display = 'block';
}

function importLinksStepBack() {
    document.getElementById('import-links-step-2').style.display = 'none';
    document.getElementById('import-links-step-1').style.display = 'block';
}

async function importLinksWithMapping() {
    if (!importLinksCsvFile) {
        alert('No CSV file selected.');
        return;
    }

    const mapping = {
        link_id: document.getElementById('map-link-id').value,
        coordinates: document.getElementById('map-coordinates').value,
    };

    // Validate required fields
    if (!mapping.link_id || !mapping.coordinates) {
        alert('Please select columns for Link ID and Coordinates.');
        return;
    }

    const nameCol = document.getElementById('map-link-name').value;
    if (nameCol) mapping.name = nameCol;

    const typeCol = document.getElementById('map-link-type').value;
    if (typeCol) mapping.link_type = typeCol;

    const formData = new FormData();
    formData.append('file', importLinksCsvFile);
    formData.append('column_mapping', JSON.stringify(mapping));

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/import-links-csv/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            body: formData
        });

        const result = await response.json();
        if (response.ok) {
            alert(`Link import complete:\n${result.created} created\n${result.updated} updated\n${result.errors.length} errors`);
            hideImportLinksModal();
            loadProjectData();
        } else {
            alert('Error: ' + result.error);
        }
    } catch (error) {
        console.error('Link import error:', error);
    }
}

// Form Handlers
document.getElementById('uploadForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const formData = new FormData(this);

    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/sheets/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            },
            body: formData
        });

        if (response.ok) {
            const result = await response.json();
            hideUploadModal();

            // Show message about how many sheets were created
            if (Array.isArray(result)) {
                const count = result.length;
                if (count > 1) {
                    alert(`PDF imported successfully! Created ${count} sheets (one per page).`);
                }
            }

            loadProjectData();
            this.reset();  // Reset form for next upload
        } else {
            const error = await response.json();
            alert('Error: ' + JSON.stringify(error));
        }
    } catch (error) {
        console.error('Upload error:', error);
    }
});

// Export Functions
async function exportProject() {
    try {
        const response = await fetch(`/api/projects/${PROJECT_ID}/export/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({})
        });

        const result = await response.json();
        if (response.ok) {
            alert('Export complete! Files saved to: ' + result.exports.map(e => e.output_path).join(', '));
        } else {
            alert('Export error: ' + result.error);
        }
    } catch (error) {
        console.error('Export error:', error);
    }
}

function downloadReport() {
    window.open(`/api/projects/${PROJECT_ID}/adjustment-report/?format=csv`, '_blank');
}

// Cut Line Tool - draws a line to hide one side of a sheet
let cutLine = null;
let cutLineStart = null;
let targetSheetObj = null;

/**
 * Check if a point is in the visible (non-clipped) area of an object
 * @param {fabric.Object} obj - The object with clipPath
 * @param {Object} pointer - Canvas coordinates {x, y}
 * @returns {boolean} - True if point is in visible area
 */
function updateCutStats(startPt, endPt) {
    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angleDeg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;

    const label = `${angleDeg.toFixed(1)}°  ${Math.round(length)}px`;
    const midX = (startPt.x + endPt.x) / 2;
    const midY = (startPt.y + endPt.y) / 2;

    if (!cutStatsLabel) {
        cutStatsLabel = new fabric.Text(label, {
            left: midX,
            top: midY - 20,
            fontSize: 13,
            fill: '#ffffff',
            backgroundColor: 'rgba(0,0,0,0.7)',
            fontFamily: 'monospace',
            padding: 4,
            selectable: false,
            evented: false
        });
        canvas.add(cutStatsLabel);
    } else {
        cutStatsLabel.set({ text: label, left: midX, top: midY - 20 });
    }
    canvas.bringToFront(cutStatsLabel);
}

function removeCutStats() {
    if (cutStatsLabel) {
        canvas.remove(cutStatsLabel);
        cutStatsLabel = null;
    }
}

function isPointInVisibleArea(obj, pointer) {
    if (!obj._clipPolygon) return true;

    // Convert pointer to object-local coordinates
    const point = new fabric.Point(pointer.x, pointer.y);
    const invertedMatrix = fabric.util.invertTransform(obj.calcTransformMatrix());
    const localPoint = fabric.util.transformPoint(point, invertedMatrix);

    // Ray-casting point-in-polygon test against the clip polygon
    var inside = false;
    var poly = obj._clipPolygon;
    for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i].x, yi = poly[i].y;
        var xj = poly[j].x, yj = poly[j].y;
        if (((yi > localPoint.y) !== (yj > localPoint.y)) &&
            (localPoint.x < (xj - xi) * (localPoint.y - yi) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

function handleCropClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    console.log('handleCropClick called, pointer:', pointer, 'isCropping:', isCropping);

    // Find sheet under click - try multiple methods for reliability
    let clickedSheetObj = null;

    // Method 1: Use opt.target if available
    if (opt.target && opt.target.sheetData) {
        clickedSheetObj = opt.target;
        console.log('Method 1 - opt.target:', opt.target.sheetData.name);
    }

    // Method 2: Use findTarget with event
    if (!clickedSheetObj) {
        const foundObj = canvas.findTarget(opt.e, true);
        if (foundObj && foundObj.sheetData) {
            clickedSheetObj = foundObj;
            console.log('Method 2 - findTarget:', foundObj.sheetData.name);
        }
    }

    // Method 3: Use getBoundingRect for proper rotation handling
    if (!clickedSheetObj) {
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                // Use getBoundingRect which properly accounts for rotation
                const bounds = obj.getBoundingRect();
                if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                    pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                    clickedSheetObj = obj;
                    console.log('Method 3 - bounding rect:', obj.sheetData.name);
                }
            }
        });
    }

    // Method 4: Check if point is in visible area (not clipped)
    if (clickedSheetObj && clickedSheetObj._clipPolygon) {
        if (!isPointInVisibleArea(clickedSheetObj, pointer)) {
            console.log('Point is in clipped area, looking for sheet underneath');
            const clippedSheet = clickedSheetObj;
            clickedSheetObj = null;
            // Look for another sheet underneath
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData && obj !== clippedSheet) {
                    const bounds = obj.getBoundingRect();
                    if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                        pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                        if (!obj._clipPolygon || isPointInVisibleArea(obj, pointer)) {
                            clickedSheetObj = obj;
                        }
                    }
                }
            });
        }
    }

    console.log('All sheets on canvas:', canvas.getObjects().filter(o => o.sheetData).length);

    if (!isCropping) {
        // Start cut line
        if (!clickedSheetObj) {
            console.log('Cut line must start on a sheet - no sheet found under click');
            console.log('Available sheets:', canvas.getObjects().filter(o => o.sheetData).map(o => o.sheetData.name));
            return;
        }

        targetSheetObj = clickedSheetObj;
        selectSheet(targetSheetObj.sheetData.id);
        isCropping = true;
        cutLineStart = pointer;

        console.log('Starting cut line at:', pointer);

        // Draw the cut line
        cutLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: '#ff0000',
            strokeWidth: 1,
            strokeUniform: true,
            selectable: false,
            evented: false
        });
        canvas.add(cutLine);
        canvas.bringToFront(cutLine);
        canvas.renderAll();
        console.log('Cut line added to canvas');
    }
}

function handleCropMove(opt) {
    if (!isCropping || !cutLine || !cutLineStart) return;

    const pointer = canvas.getPointer(opt.e);
    cutLine.set({ x2: pointer.x, y2: pointer.y });
    updateCutStats(cutLineStart, pointer);
    canvas.renderAll();
}

// Debug: Log mode changes
const originalSetMode = setMode;
// Overwrite setMode to add logging (will be defined later in file, so we patch it at load time)
document.addEventListener('DOMContentLoaded', function() {
    console.log('Canvas editor loaded, currentMode:', currentMode);
});

function handleCropEnd(opt) {
    if (!isCropping || !cutLine || !cutLineStart || !targetSheetObj) return;

    const pointer = canvas.getPointer(opt.e);

    // Calculate line length
    const dx = pointer.x - cutLineStart.x;
    const dy = pointer.y - cutLineStart.y;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength > 20) {
        // Apply cut mask to the sheet
        applyCutMask(targetSheetObj, cutLineStart, pointer);
    }

    // Clean up
    canvas.remove(cutLine);
    cutLine = null;
    cutLineStart = null;
    targetSheetObj = null;
    isCropping = false;
    removeCutStats();
}

function applyCutMask(sheetObj, p1, p2) {
    const sheetId = sheetObj.sheetData.id;

    // Save undo state - capture the entire previous cuts array
    const previousCuts = sheetCutData[sheetId]
        ? JSON.parse(JSON.stringify(sheetCutData[sheetId]))
        : null;
    saveUndoState('cut', {
        sheetId: sheetId,
        previousCutData: previousCuts
    });

    // Convert canvas-space coordinates to sheet-local coordinates before storing.
    // This ensures cuts survive reload regardless of the sheet's canvas position.
    const invertedMatrix = fabric.util.invertTransform(sheetObj.calcTransformMatrix());
    const localP1 = fabric.util.transformPoint(new fabric.Point(p1.x, p1.y), invertedMatrix);
    const localP2 = fabric.util.transformPoint(new fabric.Point(p2.x, p2.y), invertedMatrix);

    // Append new cut to existing array (in local/sheet-relative coordinates)
    const newCut = {
        p1: { x: localP1.x, y: localP1.y },
        p2: { x: localP2.x, y: localP2.y },
        flipped: false
    };

    if (!sheetCutData[sheetId]) {
        sheetCutData[sheetId] = [];
    }
    sheetCutData[sheetId].push(newCut);

    // Apply all cuts
    applyAllCuts(sheetObj, sheetCutData[sheetId]);
    saveCutData(sheetId, sheetCutData[sheetId]);
    console.log('Cut added to sheet:', sheetObj.sheetData.name,
                'Total cuts:', sheetCutData[sheetId].length);
}

/**
 * Sutherland-Hodgman polygon clipping: clips polygon against one half-plane.
 * Points on the LEFT side of edgeP1->edgeP2 are kept.
 */
function clipPolygonByEdge(subjectPolygon, edgeP1, edgeP2) {
    if (subjectPolygon.length === 0) return [];

    const output = [];
    const edgeDx = edgeP2.x - edgeP1.x;
    const edgeDy = edgeP2.y - edgeP1.y;

    function cross(point) {
        return edgeDx * (point.y - edgeP1.y) - edgeDy * (point.x - edgeP1.x);
    }

    function intersection(a, b) {
        const ca = cross(a);
        const cb = cross(b);
        const denom = ca - cb;
        if (Math.abs(denom) < 1e-10) {
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        }
        const t = ca / denom;
        return {
            x: a.x + t * (b.x - a.x),
            y: a.y + t * (b.y - a.y)
        };
    }

    for (let i = 0; i < subjectPolygon.length; i++) {
        const current = subjectPolygon[i];
        const next = subjectPolygon[(i + 1) % subjectPolygon.length];
        const currentInside = cross(current) >= 0;
        const nextInside = cross(next) >= 0;

        if (currentInside) {
            output.push(current);
            if (!nextInside) {
                output.push(intersection(current, next));
            }
        } else if (nextInside) {
            output.push(intersection(current, next));
        }
    }

    return output;
}

/**
 * Compute the intersection of multiple half-plane cuts into a single polygon.
 * Returns array of {x, y} in local coordinates, or null if everything is clipped away.
 */
function computeMultiCutPolygon(sheetObj, cuts) {
    const imgWidth = sheetObj.width;
    const imgHeight = sheetObj.height;
    const padding = Math.max(imgWidth, imgHeight) * 0.6;

    // Start with a rectangle covering the full image in local coords (origin at center)
    let polygon = [
        { x: -imgWidth / 2 - padding, y: -imgHeight / 2 - padding },
        { x:  imgWidth / 2 + padding, y: -imgHeight / 2 - padding },
        { x:  imgWidth / 2 + padding, y:  imgHeight / 2 + padding },
        { x: -imgWidth / 2 - padding, y:  imgHeight / 2 + padding }
    ];

    // Cut coordinates are already in sheet-local space (converted at draw/split time)
    for (const cut of cuts) {
        const localP1 = { x: cut.p1.x, y: cut.p1.y };
        const localP2 = { x: cut.p2.x, y: cut.p2.y };

        const dx = localP2.x - localP1.x;
        const dy = localP2.y - localP1.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) continue;

        // Perpendicular (90 CCW = left side of direction)
        let px = -dy / len;
        let py =  dx / len;

        // Point perpendicular toward sheet center (0,0 in local coords)
        const midX = (localP1.x + localP2.x) / 2;
        const midY = (localP1.y + localP2.y) / 2;
        const dotProduct = (0 - midX) * px + (0 - midY) * py;
        if (dotProduct < 0) {
            px = -px;
            py = -py;
        }

        // Apply user flip
        if (cut.flipped) {
            px = -px;
            py = -py;
        }

        // Orient edge so "keep" side is on the LEFT of edgeP1->edgeP2
        const leftPx = -dy / len;
        const leftPy =  dx / len;
        const isLeftSide = (px * leftPx + py * leftPy) > 0;

        let edgeP1, edgeP2;
        if (isLeftSide) {
            edgeP1 = localP1;
            edgeP2 = localP2;
        } else {
            edgeP1 = localP2;
            edgeP2 = localP1;
        }

        polygon = clipPolygonByEdge(polygon, edgeP1, edgeP2);
        if (polygon.length === 0) return null;
    }

    // Round to integers for pixel-perfect edges
    return polygon.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

/**
 * Apply all cuts for a sheet, computing the composite clip polygon.
 * Uses native Canvas 2D clip() instead of Fabric.js clipPath to avoid
 * caching/compositing issues when filters (PDF inversion) are active.
 */
function applyAllCuts(sheetObj, cuts) {
    if (!cuts || cuts.length === 0) {
        // Remove custom clip rendering
        sheetObj._clipPolygon = null;
        sheetObj.clipPath = null;
        if (sheetObj._originalRender) {
            sheetObj._render = sheetObj._originalRender;
            delete sheetObj._originalRender;
        }
        sheetObj.objectCaching = true;
        sheetObj.dirty = true;
        canvas.renderAll();
        return;
    }

    const polygon = computeMultiCutPolygon(sheetObj, cuts);

    if (!polygon || polygon.length < 3) {
        console.warn('All cuts clip away the entire sheet');
        sheetObj._clipPolygon = null;
        sheetObj.clipPath = null;
        sheetObj.dirty = true;
        canvas.renderAll();
        return;
    }

    // Store polygon for manual clipping (points are in image-local
    // center-based coords, matching the _render coordinate space)
    sheetObj._clipPolygon = polygon;
    sheetObj.clipPath = null;  // Don't use Fabric.js clipPath

    // Override _render to apply native canvas clip() before drawing.
    // This avoids destination-in compositing and cache interaction bugs.
    if (!sheetObj._originalRender) {
        sheetObj._originalRender = sheetObj._render;
    }
    sheetObj._render = function(ctx) {
        if (this._clipPolygon && this._clipPolygon.length >= 3 && !this._showUncut) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(this._clipPolygon[0].x, this._clipPolygon[0].y);
            for (var i = 1; i < this._clipPolygon.length; i++) {
                ctx.lineTo(this._clipPolygon[i].x, this._clipPolygon[i].y);
            }
            ctx.closePath();
            ctx.clip();
        }
        this._originalRender(ctx);
        if (this._clipPolygon && !this._showUncut) {
            ctx.restore();
        }
    };

    sheetObj.objectCaching = false;
    sheetObj.dirty = true;
    canvas.renderAll();
    updateContextTools();
}

/**
 * Backward-compatible wrapper for single-cut callers.
 */
function applyCutMaskWithDirection(sheetObj, p1, p2, flipped) {
    applyAllCuts(sheetObj, [{ p1, p2, flipped }]);
}

async function saveCutData(sheetId, cuts) {
    try {
        const response = await fetch(`/api/sheets/${sheetId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                cuts_json: cuts
            })
        });
        if (response.ok) {
            console.log('Cut data saved, count:', cuts.length);
        }
    } catch (error) {
        console.error('Error saving cut data:', error);
    }
}

function clearSheetCut(sheetId) {
    // Find the sheet object and remove its clip
    canvas.getObjects().forEach(obj => {
        if (obj.sheetData && obj.sheetData.id === sheetId) {
            obj.clipPath = null;
            obj._clipPolygon = null;
            if (obj._originalRender) {
                obj._render = obj._originalRender;
                delete obj._originalRender;
            }
            obj.objectCaching = true;
            obj.dirty = true;
            canvas.renderAll();
        }
    });
}

function clearSelectedSheetCut() {
    if (!selectedSheet) {
        console.log('No sheet selected for clearing cut');
        return;
    }

    // Save undo state before clearing - capture current cuts array
    const existingCuts = sheetCutData[selectedSheet.id];
    if (existingCuts && existingCuts.length > 0) {
        saveUndoState('clearCut', {
            sheetId: selectedSheet.id,
            cutData: JSON.parse(JSON.stringify(existingCuts))
        });
    }

    clearSheetCut(selectedSheet.id);
    delete sheetCutData[selectedSheet.id];

    // Save empty cuts to server
    saveCutData(selectedSheet.id, []);
    console.log('All cuts cleared from sheet:', selectedSheet.name);
    updateContextTools();
}

function flipSelectedSheetCut() {
    if (!selectedSheet) {
        console.log('No sheet selected for flip');
        return;
    }

    const cuts = sheetCutData[selectedSheet.id];
    if (!cuts || cuts.length === 0) {
        console.log('No cut data to flip');
        return;
    }

    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === selectedSheet.id
    );
    if (!sheetObj) return;

    // Flip the last (most recently added) cut
    const lastCut = cuts[cuts.length - 1];
    lastCut.flipped = !lastCut.flipped;

    // Reapply all cuts
    applyAllCuts(sheetObj, cuts);
    saveCutData(selectedSheet.id, cuts);
}

function toggleShowUncut() {
    if (!selectedSheet) return;

    const sheetId = selectedSheet.id;
    const sheetObj = canvas.getObjects().find(obj =>
        obj.sheetData && obj.sheetData.id === sheetId
    );
    if (!sheetObj || !sheetObj._clipPolygon) return;

    if (showUncutSheetId === sheetId) {
        // Re-enable clipping
        showUncutSheetId = null;
        sheetObj._showUncut = false;
    } else {
        // Reset previous show-uncut sheet if any
        if (showUncutSheetId !== null) {
            const prevObj = canvas.getObjects().find(obj =>
                obj.sheetData && obj.sheetData.id === showUncutSheetId
            );
            if (prevObj) {
                prevObj._showUncut = false;
                prevObj.dirty = true;
            }
        }
        showUncutSheetId = sheetId;
        sheetObj._showUncut = true;
    }
    sheetObj.dirty = true;
    canvas.renderAll();
    updateContextTools();
}

// Split Sheet Tool - splits a sheet into two independent pieces
let splitLine = null;
let splitLineStart = null;
let splitTargetSheet = null;
let isSplitting = false;

function handleSplitClick(opt) {
    const pointer = canvas.getPointer(opt.e);

    console.log('handleSplitClick called, pointer:', pointer, 'isSplitting:', isSplitting);

    // Find sheet under click using same methods as crop
    let clickedSheetObj = null;

    if (opt.target && opt.target.sheetData) {
        clickedSheetObj = opt.target;
    }

    if (!clickedSheetObj) {
        const foundObj = canvas.findTarget(opt.e, true);
        if (foundObj && foundObj.sheetData) {
            clickedSheetObj = foundObj;
        }
    }

    if (!clickedSheetObj) {
        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) {
                const bounds = obj.getBoundingRect();
                if (pointer.x >= bounds.left && pointer.x <= bounds.left + bounds.width &&
                    pointer.y >= bounds.top && pointer.y <= bounds.top + bounds.height) {
                    clickedSheetObj = obj;
                }
            }
        });
    }

    if (!isSplitting) {
        if (!clickedSheetObj) {
            console.log('Split line must start on a sheet');
            return;
        }

        splitTargetSheet = clickedSheetObj;
        selectSheet(splitTargetSheet.sheetData.id);
        isSplitting = true;
        splitLineStart = pointer;

        console.log('Starting split line at:', pointer);

        // Draw the split line (different color from cut)
        splitLine = new fabric.Line([pointer.x, pointer.y, pointer.x, pointer.y], {
            stroke: '#00ff00',  // Green for split
            strokeWidth: 1,
            strokeUniform: true,
            selectable: false,
            evented: false
        });
        canvas.add(splitLine);
        canvas.bringToFront(splitLine);
        canvas.renderAll();
    }
}

function handleSplitMove(opt) {
    if (!isSplitting || !splitLine || !splitLineStart) return;

    const pointer = canvas.getPointer(opt.e);
    splitLine.set({ x2: pointer.x, y2: pointer.y });
    updateCutStats(splitLineStart, pointer);
    canvas.renderAll();
}

async function handleSplitEnd(opt) {
    if (!isSplitting || !splitLine || !splitLineStart || !splitTargetSheet) return;

    const pointer = canvas.getPointer(opt.e);

    // Calculate line length
    const dx = pointer.x - splitLineStart.x;
    const dy = pointer.y - splitLineStart.y;
    const lineLength = Math.sqrt(dx * dx + dy * dy);

    if (lineLength > 20) {
        // Convert canvas-space coords to sheet-local coords before sending/storing
        const invertedMatrix = fabric.util.invertTransform(splitTargetSheet.calcTransformMatrix());
        const localP1 = fabric.util.transformPoint(new fabric.Point(splitLineStart.x, splitLineStart.y), invertedMatrix);
        const localP2 = fabric.util.transformPoint(new fabric.Point(pointer.x, pointer.y), invertedMatrix);

        // Call API to split the sheet (send local coordinates)
        try {
            const response = await fetch(`/api/sheets/${splitTargetSheet.sheetData.id}/split/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': getCSRFToken()
                },
                body: JSON.stringify({
                    p1: { x: localP1.x, y: localP1.y },
                    p2: { x: localP2.x, y: localP2.y }
                })
            });

            if (response.ok) {
                const result = await response.json();
                console.log('Sheet split successfully:', result);

                // Append cut to original sheet's existing cuts (local coordinates)
                const originalId = splitTargetSheet.sheetData.id;
                if (!sheetCutData[originalId]) {
                    sheetCutData[originalId] = [];
                }
                sheetCutData[originalId].push({
                    p1: { x: localP1.x, y: localP1.y },
                    p2: { x: localP2.x, y: localP2.y },
                    flipped: false
                });
                applyAllCuts(splitTargetSheet, sheetCutData[originalId]);

                // Add new sheet to canvas with opposite cut
                const newSheet = result.new_sheet;
                sheets.push(newSheet);
                renderSheetLayers();

                // Load the new sheet onto canvas
                if (newSheet.rendered_image_url) {
                    fabric.Image.fromURL(newSheet.rendered_image_url, function(img) {
                        img.set({
                            left: newSheet.offset_x,
                            top: newSheet.offset_y,
                            angle: newSheet.rotation,
                            selectable: currentMode === 'select',
                            evented: true,
                            hasControls: false,
                            hasBorders: false,
                            lockScalingX: true,
                            lockScalingY: true,
                            lockUniScaling: true,
                            lockRotation: false,
                        });
                        img.sheetData = newSheet;
                        canvas.add(img);

                        // Apply PDF inversion FIRST (before cuts so filters don't reset clip)
                        if (isPdfInverted) {
                            if (!img.filters) img.filters = [];
                            img.filters.push(new fabric.Image.filters.Invert());
                            applyFiltersPreservingSize(img);
                        }

                        // Apply opposite cut to new sheet from server response (after filters)
                        const newCuts = newSheet.cuts_json || [];
                        if (newCuts.length > 0) {
                            sheetCutData[newSheet.id] = newCuts;
                            applyAllCuts(img, newCuts);
                        }

                        canvas.renderAll();
                    }, { crossOrigin: 'anonymous' });
                }

                alert('Sheet split successfully! The new sheet shows the opposite side.');
            } else {
                const error = await response.json();
                alert('Error splitting sheet: ' + JSON.stringify(error));
            }
        } catch (error) {
            console.error('Error splitting sheet:', error);
            alert('Error splitting sheet');
        }
    }

    // Clean up
    canvas.remove(splitLine);
    splitLine = null;
    splitLineStart = null;
    splitTargetSheet = null;
    isSplitting = false;
    removeCutStats();
}

// Close modals on outside click (but not while in verify-asset mode)
document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', function(e) {
        if (e.target === this && currentMode !== 'verify-asset') {
            this.style.display = 'none';
        }
    });
});

// ==================== Collapsible Sidebars ====================

function toggleLeftSidebar() {
    const sidebar = document.getElementById('sidebar-left');
    const btn = sidebar.querySelector('.sidebar-toggle');
    sidebar.classList.toggle('collapsed');
    btn.innerHTML = sidebar.classList.contains('collapsed') ? '&raquo;' : '&laquo;';
    // Resize canvas after transition
    setTimeout(resizeCanvasToFit, 220);
}

function toggleRightSidebar() {
    const sidebar = document.getElementById('sidebar-right');
    const btn = document.querySelector('.right-toggle-btn');
    sidebar.classList.toggle('collapsed');
    btn.innerHTML = sidebar.classList.contains('collapsed') ? '&laquo;' : '&raquo;';
    
    // Toggle body class for dark mode button positioning
    document.body.classList.toggle('right-sidebar-collapsed', sidebar.classList.contains('collapsed'));
    
    // Resize canvas after transition
    setTimeout(resizeCanvasToFit, 220);
}

function resizeCanvasToFit() {
    const container = document.getElementById('canvas-container');
    if (container && canvas) {
        const rect = container.getBoundingClientRect();
        canvas.setDimensions({ width: rect.width, height: rect.height });
        canvas.renderAll();
    }
}

// ==================== Import Batches ====================

async function renderImportBatches() {
    const container = document.getElementById('import-batches');
    if (!container) return;

    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/import-batches/`);
        if (!resp.ok) return;
        const allBatches = await resp.json();
        
        // Filter out link batches (those with filenames starting with "links:")
        const batches = allBatches.filter(b => !b.filename.startsWith('links:'));

        container.innerHTML = '';
        if (batches.length === 0) return;

        batches.forEach(batch => {
            const div = document.createElement('div');
            div.className = 'batch-item';

            const header = document.createElement('div');
            header.className = 'batch-header';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'batch-name';
            nameSpan.textContent = batch.filename;
            nameSpan.title = batch.filename;

            const countSpan = document.createElement('span');
            countSpan.className = 'batch-count';
            countSpan.textContent = `${batch.asset_count}`;

            const typeBtn = document.createElement('button');
            typeBtn.className = 'batch-delete-btn';
            typeBtn.textContent = '\u25CF';
            typeBtn.title = 'Change asset type for this batch';
            typeBtn.style.fontSize = '0.75rem';
            typeBtn.addEventListener('click', function() { showBatchTypeSelect(div, batch.id); });

            const delBtn = document.createElement('button');
            delBtn.className = 'batch-delete-btn';
            delBtn.textContent = '\u00D7';
            delBtn.title = 'Delete this batch and its assets';
            delBtn.addEventListener('click', () => deleteImportBatch(batch.id, batch.filename));

            const visCheckbox = document.createElement('input');
            visCheckbox.type = 'checkbox';
            visCheckbox.className = 'batch-visibility';
            visCheckbox.checked = true;
            visCheckbox.title = 'Toggle batch visibility';
            visCheckbox.style.marginRight = '0.3rem';
            visCheckbox.addEventListener('change', function() {
                toggleBatchVisibility(batch.id, this.checked);
            });

            header.appendChild(visCheckbox);
            header.appendChild(nameSpan);
            header.appendChild(countSpan);
            header.appendChild(typeBtn);
            header.appendChild(delBtn);
            div.appendChild(header);
            container.appendChild(div);
        });
    } catch (err) {
        console.error('Error loading import batches:', err);
    }
}

/**
 * Render link import batches in the Links section
 */
async function renderLinkImportBatches() {
    const container = document.getElementById('link-import-batches');
    if (!container) return;

    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/import-batches/`);
        if (!resp.ok) return;
        const allBatches = await resp.json();
        
        // Filter to only link batches (those with filenames starting with "links:")
        const batches = allBatches.filter(b => b.filename.startsWith('links:'));

        container.innerHTML = '';
        if (batches.length === 0) return;

        batches.forEach(batch => {
            const div = document.createElement('div');
            div.className = 'batch-item';

            const header = document.createElement('div');
            header.className = 'batch-header';

            const nameSpan = document.createElement('span');
            nameSpan.className = 'batch-name';
            // Remove the "links:" prefix for display
            const displayName = batch.filename.replace(/^links:/, '');
            nameSpan.textContent = displayName;
            nameSpan.title = displayName;

            const countSpan = document.createElement('span');
            countSpan.className = 'batch-count';
            countSpan.textContent = `${batch.asset_count}`;

            const delBtn = document.createElement('button');
            delBtn.className = 'batch-delete-btn';
            delBtn.textContent = '\u00D7';
            delBtn.title = 'Delete this batch and its links';
            delBtn.addEventListener('click', () => deleteLinkImportBatch(batch.id, displayName));

            const visCheckbox = document.createElement('input');
            visCheckbox.type = 'checkbox';
            visCheckbox.className = 'batch-visibility';
            visCheckbox.checked = true;
            visCheckbox.title = 'Toggle batch visibility';
            visCheckbox.style.marginRight = '0.3rem';
            visCheckbox.addEventListener('change', function() {
                toggleLinkBatchVisibility(batch.id, this.checked);
            });

            header.appendChild(visCheckbox);
            header.appendChild(nameSpan);
            header.appendChild(countSpan);
            header.appendChild(delBtn);
            div.appendChild(header);
            container.appendChild(div);
        });
    } catch (err) {
        console.error('Error loading link import batches:', err);
    }
}

/**
 * Delete a link import batch and its associated links
 */
async function deleteLinkImportBatch(batchId, filename) {
    if (!confirm(`Delete batch "${filename}" and all its links?`)) return;

    try {
        const resp = await fetch(`/api/import-batches/${batchId}/`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });

        if (resp.ok) {
            await loadProjectData();
        } else {
            alert('Failed to delete batch');
        }
    } catch (err) {
        console.error('Error deleting link batch:', err);
    }
}

/**
 * Toggle visibility for links in a batch
 */
function toggleLinkBatchVisibility(batchId, visible) {
    // Filter links by import_batch and toggle visibility
    links.forEach(link => {
        if (link.import_batch === batchId) {
            const fabricObj = canvas.getObjects().find(o => o.linkId === link.id);
            if (fabricObj) {
                fabricObj.visible = visible;
            }
        }
    });
    canvas.requestRenderAll();
}

function showBatchTypeSelect(batchDiv, batchId) {
    // Remove any existing type-select row
    var existing = batchDiv.querySelector('.batch-type-row');
    if (existing) { existing.remove(); return; }

    var row = document.createElement('div');
    row.className = 'batch-type-row';
    row.style.cssText = 'display: flex; gap: 0.25rem; margin-top: 0.3rem; align-items: center;';

    var sel = document.createElement('select');
    sel.style.cssText = 'flex: 1; padding: 0.2rem; border: 1px solid var(--border-color, #ddd); border-radius: 4px; font-size: 0.8rem; background: var(--bg-input, #fff); color: var(--text-primary, #333);';

    // Populate from known asset types (gathered from loaded assets)
    var typeNames = {};
    assets.forEach(function(a) {
        if (a.asset_type_data && a.asset_type_data.name) typeNames[a.asset_type_data.name] = true;
    });
    // Always include the 3 defaults
    ['TN Intersection', 'VSL', 'CCTV'].forEach(function(n) { typeNames[n] = true; });

    Object.keys(typeNames).sort().forEach(function(name) {
        var opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
    });

    // Custom option
    var customOpt = document.createElement('option');
    customOpt.value = '__custom__';
    customOpt.textContent = '+ New type...';
    sel.appendChild(customOpt);

    var applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-success';
    applyBtn.textContent = 'Apply';
    applyBtn.style.cssText = 'padding: 0.2rem 0.5rem; font-size: 0.8rem;';
    applyBtn.addEventListener('click', function() {
        var typeName = sel.value;
        if (typeName === '__custom__') {
            typeName = prompt('Enter new asset type name:');
            if (!typeName || !typeName.trim()) return;
            typeName = typeName.trim();
        }
        reassignBatchType(batchId, typeName);
    });

    row.appendChild(sel);
    row.appendChild(applyBtn);
    batchDiv.appendChild(row);
}

async function reassignBatchType(batchId, typeName) {
    try {
        var resp = await fetch('/api/import-batches/' + batchId + '/', {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ asset_type_name: typeName })
        });
        if (!resp.ok) {
            var data = await resp.json().catch(function() { return {}; });
            alert(data.error || 'Failed to reassign asset type');
            return;
        }
        await resp.json();
        // Reload assets to reflect new types
        var assetsResp = await fetch('/api/projects/' + PROJECT_ID + '/assets/');
        assets = await assetsResp.json();
        renderAssetList();
        refreshAssets();
        renderImportBatches();
    } catch (err) {
        console.error('Error reassigning batch type:', err);
        alert('Error reassigning asset type');
    }
}

async function deleteImportBatch(batchId, filename) {
    if (!confirm(`Delete batch "${filename}" and all its assets?`)) return;

    try {
        const resp = await fetch(`/api/import-batches/${batchId}/`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            alert(data.error || 'Failed to delete batch');
            return;
        }
        // Reload assets and batch list
        const assetsResp = await fetch(`/api/projects/${PROJECT_ID}/assets/`);
        assets = await assetsResp.json();

        // Clear calibration if no assets remain
        if (assets.length === 0) {
            refAssetId = '';
            refPixelX = 0;
            refPixelY = 0;
            assetRotationDeg = 0;
            PROJECT_DATA.ref_asset_id = '';
            PROJECT_DATA.ref_pixel_x = 0;
            PROJECT_DATA.ref_pixel_y = 0;
            PROJECT_DATA.asset_rotation = 0;
            if (verifyRefMarker) {
                canvas.remove(verifyRefMarker);
                verifyRefMarker = null;
            }
        }

        renderAssetList();
        refreshAssets();
        renderImportBatches();
    } catch (err) {
        console.error('Error deleting batch:', err);
        alert('Error deleting batch');
    }
}

async function deleteAsset(assetId, assetLabel) {
    if (!confirm(`Delete asset "${assetLabel}"?`)) return false;

    try {
        const resp = await fetch(`/api/assets/${assetId}/`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });
        if (!resp.ok) {
            if (typeof showToast === 'function') {
                showToast('Failed to delete asset', 'error');
            } else {
                alert('Failed to delete asset');
            }
            return false;
        }
        // Reload assets
        const assetsResp = await fetch(`/api/projects/${PROJECT_ID}/assets/`);
        assets = await assetsResp.json();
        renderAssetList();
        refreshAssets();
        renderImportBatches();
        if (typeof showToast === 'function') {
            showToast(`Asset "${assetLabel}" deleted`, 'success');
        }
        return true;
    } catch (err) {
        console.error('Error deleting asset:', err);
        if (typeof showToast === 'function') {
            showToast('Error deleting asset', 'error');
        } else {
            alert('Error deleting asset');
        }
        return false;
    }
}

/**
 * Delete a single link
 */
async function deleteLink(linkId, linkLabel) {
    if (!confirm(`Delete link "${linkLabel}"?`)) return false;

    try {
        const resp = await fetch(`/api/links/${linkId}/`, {
            method: 'DELETE',
            headers: { 'X-CSRFToken': getCSRFToken() }
        });
        if (!resp.ok) {
            if (typeof showToast === 'function') {
                showToast('Failed to delete link', 'error');
            } else {
                alert('Failed to delete link');
            }
            return false;
        }
        // Reload links
        const linksResp = await fetch(`/api/projects/${PROJECT_ID}/links/`);
        links = await linksResp.json();
        renderLinkList();
        renderLinkGroupList();
        if (typeof showToast === 'function') {
            showToast(`Link "${linkLabel}" deleted`, 'success');
        }
        return true;
    } catch (err) {
        console.error('Error deleting link:', err);
        if (typeof showToast === 'function') {
            showToast('Error deleting link', 'error');
        } else {
            alert('Error deleting link');
        }
        return false;
    }
}

// ==================== Layer Groups ====================

/**
 * Show the create group modal
 */
function showCreateGroupModal(groupType) {
    const modal = document.getElementById('createGroupModal');
    const typeInput = document.getElementById('group-type');
    const parentSelect = document.getElementById('group-parent');
    const nameInput = document.getElementById('group-name');

    if (!modal) return;

    typeInput.value = groupType;
    nameInput.value = '';

    // Populate parent options based on group type
    let groups;
    if (groupType === 'asset') {
        groups = assetGroups;
    } else if (groupType === 'sheet') {
        groups = sheetGroups;
    } else if (groupType === 'measurement') {
        groups = measurementGroups;
    } else {
        groups = linkGroups;
    }
    parentSelect.innerHTML = '<option value="">None (Root level)</option>';
    groups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        parentSelect.appendChild(opt);
    });

    modal.style.display = 'flex';
}

/**
 * Hide the create group modal
 */
function hideCreateGroupModal() {
    const modal = document.getElementById('createGroupModal');
    if (modal) modal.style.display = 'none';
}

/**
 * Create a new layer group
 */
async function createLayerGroup(e) {
    e.preventDefault();

    const groupType = document.getElementById('group-type').value;
    const name = document.getElementById('group-name').value;
    const parentId = document.getElementById('group-parent').value;
    const scope = document.getElementById('group-scope').value || 'local';

    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/layer-groups/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                name: name,
                group_type: groupType,
                scope: scope,
                parent_group: parentId || null
            })
        });

        if (resp.ok) {
            hideCreateGroupModal();
            await loadLayerGroups();
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to create group');
        }
    } catch (err) {
        console.error('Error creating group:', err);
        alert('Error creating group');
    }
}

// Set up form handler when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('createGroupForm');
    if (form) {
        form.addEventListener('submit', createLayerGroup);
    }
});

/**
 * Load layer groups for the project
 */
async function loadLayerGroups() {
    try {
        // Load all group types in parallel
        const [assetResp, linkResp, sheetResp, measurementResp] = await Promise.all([
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=asset`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=link`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=sheet`),
            fetch(`/api/projects/${PROJECT_ID}/layer-groups/?type=measurement`)
        ]);

        if (assetResp.ok) {
            assetGroups = await assetResp.json();
        }
        if (linkResp.ok) {
            linkGroups = await linkResp.json();
        }
        if (sheetResp.ok) {
            sheetGroups = await sheetResp.json();
        }
        if (measurementResp.ok) {
            measurementGroups = await measurementResp.json();
        }

        // Initialize visibility from loaded data
        [...assetGroups, ...linkGroups, ...sheetGroups, ...measurementGroups].forEach(g => {
            groupVisibility[g.id] = g.visible;
        });

        renderLayerGroupsUI();
    } catch (err) {
        console.error('Error loading layer groups:', err);
    }
}

/**
 * Render the layer groups panel UI
 */
function renderLayerGroupsUI() {
    renderAssetGroupList();
    renderLinkGroupList();
    renderSheetGroupList();
    renderMeasurementGroupList();
    renderUnifiedList();
}

/**
 * Check if potentialDescendant is a descendant of ancestorGroup
 * Used to prevent circular parent-child relationships
 */
function isDescendantOf(potentialDescendant, ancestorGroup) {
    if (!ancestorGroup.child_groups) return false;
    
    for (const child of ancestorGroup.child_groups) {
        if (child.id === potentialDescendant.id) return true;
        if (isDescendantOf(potentialDescendant, child)) return true;
    }
    return false;
}

/**
 * Get all global groups from all types (for cross-section display)
 * Deduplicates by group ID to avoid showing the same folder multiple times
 */
function getAllGlobalGroups() {
    const allGroups = [...assetGroups, ...linkGroups, ...sheetGroups, ...measurementGroups];
    const globalGroups = allGroups.filter(g => g.scope === 'global' && !g.parent_group);
    
    // Deduplicate by ID (same global folder may appear in multiple arrays)
    const seen = new Set();
    return globalGroups.filter(g => {
        if (seen.has(g.id)) return false;
        seen.add(g.id);
        return true;
    });
}

/**
 * Get item count for a group based on the current type context
 * This calculates the count client-side for accurate display
 * @param {object} group - The group object
 * @param {string} type - The item type (asset, sheet, measurement, link)
 * @param {boolean} includeNested - If true, includes items from all descendant groups
 */
function getGroupItemCountForType(group, type, includeNested = true) {
    let count = 0;
    
    // Count direct items in this group
    if (type === 'asset') {
        count = assets.filter(a => a.layer_group === group.id).length;
    } else if (type === 'sheet') {
        count = sheets.filter(s => s.layer_group === group.id).length;
    } else if (type === 'measurement') {
        const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];
        count = savedMeasurements.filter(m => m.layer_group === group.id).length;
    } else if (type === 'link') {
        count = links.filter(l => l.layer_group === group.id).length;
    }
    
    // Recursively add counts from child groups
    if (includeNested && group.child_groups && group.child_groups.length > 0) {
        group.child_groups.forEach(child => {
            count += getGroupItemCountForType(child, type, true);
        });
    }
    
    return count;
}

// Track if folder structure view is enabled in unified view
let unifiedShowFolders = false;

/**
 * Toggle the unified view between flat list and folder structure
 */
function toggleUnifiedFolderView(showFolders) {
    unifiedShowFolders = showFolders;
    renderUnifiedList();
}

/**
 * Render the unified list showing all items from all types
 */
function renderUnifiedList() {
    const container = document.getElementById('unified-items-list');
    if (!container) return;

    container.innerHTML = '';

    // Get all items from all types
    const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];
    
    // Track collapsed state for unified sections
    if (!window.unifiedSectionCollapsed) {
        window.unifiedSectionCollapsed = {};
    }
    
    // Track collapsed state for unified folders
    if (!window.unifiedFolderCollapsed) {
        window.unifiedFolderCollapsed = {};
    }

    if (unifiedShowFolders) {
        // Folder structure view - show items organized by folder hierarchy
        renderUnifiedFolderView(container, savedMeasurements);
    } else {
        // Flat view - show all items grouped by type
        renderUnifiedFlatView(container, savedMeasurements);
    }
}

/**
 * Render unified view as flat list grouped by type
 */
function renderUnifiedFlatView(container, savedMeasurements) {
    // Create sections for each type
    const sections = [
        { type: 'sheet', items: sheets, icon: '📄', label: 'Sheets' },
        { type: 'asset', items: assets, icon: '📍', label: 'Assets' },
        { type: 'link', items: links, icon: '🔗', label: 'Links' },
        { type: 'measurement', items: savedMeasurements, icon: '📐', label: 'Measurements' }
    ];

    sections.forEach(section => {
        if (section.items.length === 0) return;

        // Section header (collapsible)
        const sectionWrapper = document.createElement('div');
        sectionWrapper.className = 'unified-section';
        
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'unified-section-header';
        sectionHeader.style.cssText = `
            font-size: 0.75rem;
            font-weight: 600;
            color: var(--text-muted);
            padding: 4px 8px;
            background: var(--bg-secondary);
            border-radius: 4px;
            margin: 4px 0 2px 0;
            display: flex;
            align-items: center;
            gap: 4px;
            cursor: pointer;
            user-select: none;
        `;
        
        const isCollapsed = window.unifiedSectionCollapsed[section.type];
        
        const chevron = document.createElement('span');
        chevron.textContent = isCollapsed ? '▶' : '▼';
        chevron.style.cssText = 'font-size: 0.7rem; width: 12px;';
        
        const labelSpan = document.createElement('span');
        labelSpan.innerHTML = `<span>${section.icon}</span> ${section.label} (${section.items.length})`;
        labelSpan.style.flex = '1';
        
        sectionHeader.appendChild(chevron);
        sectionHeader.appendChild(labelSpan);
        
        // Items container
        const itemsContainer = document.createElement('div');
        itemsContainer.className = 'unified-section-items';
        if (isCollapsed) {
            itemsContainer.style.display = 'none';
        }
        
        // Toggle collapse on header click
        sectionHeader.addEventListener('click', () => {
            const nowCollapsed = !window.unifiedSectionCollapsed[section.type];
            window.unifiedSectionCollapsed[section.type] = nowCollapsed;
            chevron.textContent = nowCollapsed ? '▶' : '▼';
            itemsContainer.style.display = nowCollapsed ? 'none' : 'block';
        });
        
        sectionWrapper.appendChild(sectionHeader);

        // Render items using ToolSectionItem with icons shown
        section.items.forEach(item => {
            if (typeof ToolSectionItem !== 'undefined') {
                const itemDiv = ToolSectionItem.create(item, section.type, { showIcon: true });
                itemsContainer.appendChild(itemDiv);
            } else {
                // Fallback
                const itemDiv = document.createElement('div');
                itemDiv.className = 'unified-item';
                itemDiv.textContent = item.name || item.asset_id || 'Unnamed';
                itemsContainer.appendChild(itemDiv);
            }
        });
        
        sectionWrapper.appendChild(itemsContainer);
        container.appendChild(sectionWrapper);
    });

    // If no items at all, show message
    if (container.children.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding: 8px; color: var(--text-muted); font-size: 0.8rem; text-align: center;';
        emptyMsg.textContent = 'No items yet';
        container.appendChild(emptyMsg);
    }
}

/**
 * Render unified view as folder hierarchy
 */
function renderUnifiedFolderView(container, savedMeasurements) {
    // Collect all folders from all types
    const allGroups = [];
    const seen = new Set();
    
    [...sheetGroups, ...assetGroups, ...linkGroups, ...measurementGroups].forEach(g => {
        if (!seen.has(g.id) && !g.parent_group) {
            seen.add(g.id);
            allGroups.push(g);
        }
    });
    
    // Sort folders by name
    allGroups.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    // Render ungrouped items first
    const ungroupedSheets = sheets.filter(s => !s.layer_group);
    const ungroupedAssets = assets.filter(a => !a.layer_group);
    const ungroupedLinks = links.filter(l => !l.layer_group);
    const ungroupedMeasurements = savedMeasurements.filter(m => !m.layer_group);
    
    const totalUngrouped = ungroupedSheets.length + ungroupedAssets.length + 
                           ungroupedLinks.length + ungroupedMeasurements.length;
    
    if (totalUngrouped > 0) {
        const ungroupedSection = createUnifiedFolderSection(
            { id: 'ungrouped', name: 'Ungrouped', scope: 'local' },
            [...ungroupedSheets, ...ungroupedAssets, ...ungroupedLinks, ...ungroupedMeasurements],
            { sheets: ungroupedSheets, assets: ungroupedAssets, links: ungroupedLinks, measurements: ungroupedMeasurements },
            0
        );
        container.appendChild(ungroupedSection);
    }
    
    // Render each folder with its contents
    allGroups.forEach(group => {
        const folderEl = createUnifiedFolderSection(group, null, null, 0, savedMeasurements);
        container.appendChild(folderEl);
    });
    
    // If nothing to show
    if (container.children.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding: 8px; color: var(--text-muted); font-size: 0.8rem; text-align: center;';
        emptyMsg.textContent = 'No items yet';
        container.appendChild(emptyMsg);
    }
}

/**
 * Create a folder section for the unified folder view
 */
function createUnifiedFolderSection(group, itemsOverride, itemsByType, depth, allMeasurements) {
    const wrapper = document.createElement('div');
    wrapper.className = 'unified-folder-section';
    wrapper.style.marginLeft = (depth * 12) + 'px';
    
    // Get items for this folder
    let folderSheets, folderAssets, folderLinks, folderMeasurements;
    
    if (itemsByType) {
        // Use provided items (for ungrouped section)
        folderSheets = itemsByType.sheets || [];
        folderAssets = itemsByType.assets || [];
        folderLinks = itemsByType.links || [];
        folderMeasurements = itemsByType.measurements || [];
    } else {
        // Get items directly in this folder
        const measurements = allMeasurements || (MeasurementTool ? MeasurementTool.getSavedMeasurements() : []);
        folderSheets = sheets.filter(s => s.layer_group === group.id);
        folderAssets = assets.filter(a => a.layer_group === group.id);
        folderLinks = links.filter(l => l.layer_group === group.id);
        folderMeasurements = measurements.filter(m => m.layer_group === group.id);
    }
    
    const directItemCount = folderSheets.length + folderAssets.length + 
                            folderLinks.length + folderMeasurements.length;
    
    // Calculate total including nested
    let totalCount = directItemCount;
    if (group.child_groups && group.child_groups.length > 0) {
        group.child_groups.forEach(child => {
            totalCount += getGroupItemCountForType(child, 'sheet', true);
            totalCount += getGroupItemCountForType(child, 'asset', true);
            totalCount += getGroupItemCountForType(child, 'link', true);
            totalCount += getGroupItemCountForType(child, 'measurement', true);
        });
    }
    
    const hasContent = totalCount > 0 || (group.child_groups && group.child_groups.length > 0);
    const isCollapsed = window.unifiedFolderCollapsed[group.id];
    
    // Folder header
    const header = document.createElement('div');
    header.className = 'unified-folder-header';
    header.style.cssText = `
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: var(--bg-secondary);
        border-radius: 4px;
        margin: 2px 0;
        cursor: pointer;
        user-select: none;
        font-size: 0.8rem;
    `;
    
    const chevron = document.createElement('span');
    chevron.textContent = hasContent ? (isCollapsed ? '▶' : '▼') : '•';
    chevron.style.cssText = 'font-size: 0.7rem; width: 12px;';
    
    const icon = document.createElement('span');
    icon.textContent = group.scope === 'global' ? '🌐' : '📁';
    
    const name = document.createElement('span');
    name.textContent = group.name;
    name.style.flex = '1';
    
    const count = document.createElement('span');
    count.textContent = totalCount;
    count.style.cssText = `
        font-size: 0.7rem;
        padding: 1px 6px;
        background: var(--bg-tertiary);
        border-radius: 10px;
        color: var(--text-muted);
    `;
    
    header.appendChild(chevron);
    header.appendChild(icon);
    header.appendChild(name);
    header.appendChild(count);
    
    // Content container
    const content = document.createElement('div');
    content.className = 'unified-folder-content';
    if (isCollapsed) {
        content.style.display = 'none';
    }
    
    // Toggle collapse
    header.addEventListener('click', () => {
        const nowCollapsed = !window.unifiedFolderCollapsed[group.id];
        window.unifiedFolderCollapsed[group.id] = nowCollapsed;
        chevron.textContent = hasContent ? (nowCollapsed ? '▶' : '▼') : '•';
        content.style.display = nowCollapsed ? 'none' : 'block';
    });
    
    // Render child folders first
    if (group.child_groups && group.child_groups.length > 0) {
        group.child_groups.forEach(child => {
            const childEl = createUnifiedFolderSection(child, null, null, depth + 1, allMeasurements);
            content.appendChild(childEl);
        });
    }
    
    // Render items in this folder (organized by type)
    const itemTypes = [
        { items: folderSheets, type: 'sheet', icon: '📄' },
        { items: folderAssets, type: 'asset', icon: '📍' },
        { items: folderLinks, type: 'link', icon: '🔗' },
        { items: folderMeasurements, type: 'measurement', icon: '📐' }
    ];
    
    itemTypes.forEach(({ items, type, icon }) => {
        items.forEach(item => {
            if (typeof ToolSectionItem !== 'undefined') {
                const itemDiv = ToolSectionItem.create(item, type, { showIcon: true });
                itemDiv.style.marginLeft = '12px';
                content.appendChild(itemDiv);
            } else {
                const itemDiv = document.createElement('div');
                itemDiv.className = 'unified-item';
                itemDiv.style.marginLeft = '12px';
                itemDiv.textContent = `${icon} ${item.name || item.asset_id || 'Unnamed'}`;
                content.appendChild(itemDiv);
            }
        });
    });
    
    wrapper.appendChild(header);
    wrapper.appendChild(content);
    
    return wrapper;
}

/**
 * Render asset groups in the sidebar
 */
function renderAssetGroupList() {
    const container = document.getElementById('asset-groups-list');
    if (!container) return;

    container.innerHTML = '';

    // Count ungrouped assets
    const ungroupedAssets = assets.filter(a => !a.layer_group);
    
    // Only show "Ungrouped" folder if there are ungrouped items
    if (ungroupedAssets.length > 0) {
        const ungroupedDiv = createUngroupedFolder('asset', ungroupedAssets.length);
        container.appendChild(ungroupedDiv);
    }

    // Render local asset groups
    const localGroups = assetGroups.filter(g => !g.parent_group && g.group_type === 'asset' && g.scope === 'local');
    localGroups.forEach(group => {
        const div = createGroupItem(group, 'asset', 0);
        container.appendChild(div);
    });

    // Render all global groups (from any type) so items can be dragged into them
    const globalGroups = getAllGlobalGroups();
    globalGroups.forEach(group => {
        const div = createGroupItem(group, 'asset', 0, true); // true = isGlobalCrossType
        container.appendChild(div);
    });
}

/**
 * Render link groups in the sidebar
 */
function renderLinkGroupList() {
    const container = document.getElementById('link-groups-list');
    if (!container) return;

    container.innerHTML = '';

    // Count ungrouped links
    const ungroupedLinks = links.filter(l => !l.layer_group);
    
    // Only show "Ungrouped" folder if there are ungrouped items
    if (ungroupedLinks.length > 0) {
        const ungroupedDiv = createUngroupedFolder('link', ungroupedLinks.length);
        container.appendChild(ungroupedDiv);
    }

    // Render local link groups
    const localGroups = linkGroups.filter(g => !g.parent_group && g.group_type === 'link' && g.scope === 'local');
    localGroups.forEach(group => {
        const div = createGroupItem(group, 'link', 0);
        container.appendChild(div);
    });

    // Render all global groups (from any type) so items can be dragged into them
    const globalGroups = getAllGlobalGroups();
    globalGroups.forEach(group => {
        const div = createGroupItem(group, 'link', 0, true); // true = isGlobalCrossType
        container.appendChild(div);
    });
}

/**
 * Render measurement groups in the sidebar
 */
async function renderMeasurementGroupList() {
    const container = document.getElementById('measurement-groups-list');
    if (!container) return;

    container.innerHTML = '';

    // Load saved measurements (wait for async load)
    if (MeasurementTool && typeof MeasurementTool.loadSaved === 'function') {
        await MeasurementTool.loadSaved();
    }

    const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];

    // Count ungrouped measurements
    const ungroupedMeasurements = savedMeasurements.filter(m => !m.layer_group);
    
    // Only show "Ungrouped" folder if there are ungrouped items
    if (ungroupedMeasurements.length > 0) {
        const ungroupedDiv = createUngroupedFolder('measurement', ungroupedMeasurements.length);
        container.appendChild(ungroupedDiv);
    }

    // Render local measurement groups
    const localGroups = measurementGroups.filter(g => !g.parent_group && g.group_type === 'measurement' && g.scope === 'local');
    localGroups.forEach(group => {
        const div = createGroupItem(group, 'measurement', 0);
        container.appendChild(div);
    });

    // Render all global groups (from any type) so items can be dragged into them
    const globalGroups = getAllGlobalGroups();
    globalGroups.forEach(group => {
        const div = createGroupItem(group, 'measurement', 0, true); // true = isGlobalCrossType
        container.appendChild(div);
    });
}

/**
 * Render sheet groups in the sidebar (folder structure for sheets)
 */
function renderSheetGroupList() {
    const container = document.getElementById('sheet-layers');
    if (!container) return;

    container.innerHTML = '';

    // Check if there are any sheet groups created or global groups
    const globalGroups = getAllGlobalGroups();
    const hasSheetGroups = (sheetGroups && sheetGroups.length > 0) || globalGroups.length > 0;
    
    // Count ungrouped sheets
    const ungroupedSheets = sheets.filter(s => !s.layer_group);
    
    if (hasSheetGroups) {
        // Show folder structure if groups exist
        if (ungroupedSheets.length > 0) {
            const ungroupedDiv = createUngroupedFolder('sheet', ungroupedSheets.length);
            container.appendChild(ungroupedDiv);
        }

        // Render local sheet groups
        const localGroups = sheetGroups.filter(g => !g.parent_group && g.scope === 'local');
        localGroups.forEach(group => {
            const div = createGroupItem(group, 'sheet', 0);
            container.appendChild(div);
        });

        // Render all global groups (from any type) so items can be dragged into them
        globalGroups.forEach(group => {
            const div = createGroupItem(group, 'sheet', 0, true); // true = isGlobalCrossType
            container.appendChild(div);
        });
    } else {
        // No sheet groups exist - show sheets directly without folder structure
        sheets.forEach(sheet => {
            const div = document.createElement('div');
            div.className = 'layer-item';
            div.dataset.sheetId = sheet.id;

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'layer-visibility';
            checkbox.checked = true;
            checkbox.addEventListener('change', function() {
                toggleSheetVisibility(sheet.id, this.checked);
            });

            const span = document.createElement('span');
            span.textContent = sheet.name;

            div.appendChild(checkbox);
            div.appendChild(span);

            div.addEventListener('click', (e) => {
                if (e.target.type !== 'checkbox') {
                    selectSheet(sheet.id);
                }
            });
            container.appendChild(div);
        });
    }
}

/**
 * Create a sheet item element for display in folders
 */
/**
 * Create a sheet item element using the unified ToolSectionItem module
 */
function createSheetItem(sheet) {
    // Use the unified ToolSectionItem module if available
    if (typeof ToolSectionItem !== 'undefined') {
        return ToolSectionItem.create(sheet, 'sheet');
    }
    
    // Fallback implementation
    const div = document.createElement('div');
    div.className = 'folder-item-entry sheet-item';
    div.dataset.sheetId = sheet.id;
    div.draggable = true;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = sheet.name;

    div.appendChild(nameSpan);

    div.addEventListener('click', () => selectSheet(sheet.id));

    return div;
}

/**
 * Create an "Ungrouped" folder element
 */
function createUngroupedFolder(type, count) {
    const div = document.createElement('div');
    div.className = 'group-item ungrouped-folder';
    div.dataset.groupType = type;

    // Make it a drop target to unassign items
    div.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (draggedItem && draggedItem.type === type) {
            div.classList.add('drop-target-active');
        }
    });

    div.addEventListener('dragleave', (e) => {
        div.classList.remove('drop-target-active');
    });

    div.addEventListener('drop', async (e) => {
        e.preventDefault();
        div.classList.remove('drop-target-active');
        if (draggedItem && draggedItem.type === type) {
            await removeItemFromGroup(draggedItem.type, draggedItem.id);
            draggedItem = null;
        }
    });

    // Folder icon
    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    folderIcon.textContent = '📁';
    folderIcon.style.marginRight = '6px';

    // Folder name
    const nameSpan = document.createElement('span');
    nameSpan.className = 'group-name';
    nameSpan.textContent = 'Ungrouped';

    // Item count badge
    const countBadge = document.createElement('span');
    countBadge.className = 'group-count';
    countBadge.textContent = count;

    // Toggle to expand/collapse
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'folder-toggle';
    toggleBtn.textContent = '▼';
    toggleBtn.title = 'Toggle folder';
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const itemsList = div.querySelector('.folder-items');
        if (itemsList) {
            itemsList.classList.toggle('collapsed');
            toggleBtn.textContent = itemsList.classList.contains('collapsed') ? '▶' : '▼';
        }
    });

    div.appendChild(toggleBtn);
    div.appendChild(folderIcon);
    div.appendChild(nameSpan);
    div.appendChild(countBadge);

    // Items list (collapsed by default if many items)
    const itemsList = document.createElement('div');
    itemsList.className = 'folder-items' + (count > 10 ? ' collapsed' : '');
    
    // Show items in this ungrouped folder
    let items;
    if (type === 'asset') {
        items = assets.filter(a => !a.layer_group);
    } else if (type === 'sheet') {
        items = sheets.filter(s => !s.layer_group);
    } else if (type === 'link') {
        items = links.filter(l => !l.layer_group);
    } else if (type === 'measurement') {
        // For measurements, we need to get them from MeasurementTool
        items = MeasurementTool ? MeasurementTool.getSavedMeasurements().filter(m => !m.layer_group) : [];
    } else {
        items = [];
    }
    
    items.forEach(item => {
        const itemDiv = type === 'sheet' 
            ? createSheetItem(item) 
            : createFolderItemElement(item, type);
        itemsList.appendChild(itemDiv);
    });

    div.appendChild(itemsList);
    
    if (count > 10) {
        toggleBtn.textContent = '▶';
    }

    return div;
}

// Track dragged folder for folder-to-folder drag
let draggedFolder = null;

/**
 * Create a group/folder item element with nested support
 * @param {Object} group - The group object
 * @param {string} type - The item type context (asset, link, sheet, measurement)
 * @param {number} depth - Nesting depth
 * @param {boolean} isGlobalCrossType - True if this is a global folder shown in a different type's section
 */
function createGroupItem(group, type, depth = 0, isGlobalCrossType = false) {
    const div = document.createElement('div');
    div.className = 'group-item folder-item';
    if (isGlobalCrossType) {
        div.classList.add('global-folder');
    }
    div.dataset.groupId = group.id;
    div.dataset.groupType = type;
    div.dataset.originalType = group.group_type; // Store the original type
    div.style.marginLeft = (depth * 12) + 'px';

    // Make the folder draggable (for folder-to-folder nesting)
    div.draggable = true;
    div.addEventListener('dragstart', (e) => {
        e.stopPropagation();
        draggedFolder = { id: group.id, type: group.group_type, element: div };
        draggedItem = null; // Clear item drag
        div.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });
    
    div.addEventListener('dragend', (e) => {
        div.classList.remove('dragging');
        draggedFolder = null;
    });

    // Make the group a drop target for items AND folders
    div.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        // Check if we're dragging an item or a folder
        if (draggedItem) {
            const canAccept = group.scope === 'global' || draggedItem.type === type;
            if (canAccept) {
                div.classList.add('drop-target-active');
            }
        } else if (draggedFolder && draggedFolder.id !== group.id) {
            // Can drop folder if same type and not dropping onto itself or its children
            const canAccept = draggedFolder.type === group.group_type;
            if (canAccept) {
                div.classList.add('drop-target-active');
            }
        }
    });

    div.addEventListener('dragleave', (e) => {
        div.classList.remove('drop-target-active');
    });

    div.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        div.classList.remove('drop-target-active');
        
        if (draggedItem) {
            // Dropping an item into this folder
            const canAccept = group.scope === 'global' || draggedItem.type === type;
            if (canAccept) {
                await moveItemToGroup(group.id, draggedItem.type, draggedItem.id);
                draggedItem = null;
            }
        } else if (draggedFolder && draggedFolder.id !== group.id) {
            // Dropping a folder into this folder (joining)
            const canAccept = draggedFolder.type === group.group_type;
            if (canAccept) {
                await joinGroups(group.id, draggedFolder.id);
                draggedFolder = null;
            }
        }
    });

    // Calculate context-aware item count (for global folders showing in specific section)
    const contextItemCount = getGroupItemCountForType(group, type);
    
    // Toggle button for expand/collapse
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'folder-toggle';
    // For global cross-type folders, we only show items of the current context type
    const hasChildren = (group.child_groups && group.child_groups.length > 0) || contextItemCount > 0;
    toggleBtn.textContent = hasChildren ? '▼' : '•';
    toggleBtn.title = hasChildren ? 'Toggle folder' : '';
    toggleBtn.disabled = !hasChildren;
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const content = div.querySelector('.folder-content');
        if (content) {
            content.classList.toggle('collapsed');
            toggleBtn.textContent = content.classList.contains('collapsed') ? '▶' : '▼';
        }
    });

    // Visibility checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = groupVisibility[group.id] !== false;
    checkbox.className = 'group-visibility';
    checkbox.title = 'Toggle group visibility';
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => toggleLayerGroupVisibility(group.id, checkbox.checked));

    // Folder icon - use globe for global folders
    const folderIcon = document.createElement('span');
    folderIcon.className = 'folder-icon';
    folderIcon.textContent = group.scope === 'global' ? '🌐' : '📁';
    folderIcon.title = group.scope === 'global' ? 'Global folder (accepts all item types)' : 'Local folder';

    // Group name with type indicator for global folders shown in other sections
    const nameSpan = document.createElement('span');
    nameSpan.className = 'group-name';
    nameSpan.textContent = group.name;
    nameSpan.title = group.name + (isGlobalCrossType ? ` (${group.group_type} folder)` : '');

    // Item count badge - use context-aware count
    const countBadge = document.createElement('span');
    countBadge.className = 'group-count';
    countBadge.textContent = contextItemCount;

    // Settings cog button
    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'folder-settings';
    settingsBtn.textContent = '⚙';
    settingsBtn.title = 'Folder settings';
    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showFolderSettingsMenu(group, type, settingsBtn);
    });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'folder-delete';
    delBtn.textContent = '×';
    delBtn.title = 'Delete folder';
    delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteLayerGroup(group.id, group.name);
    });

    div.appendChild(toggleBtn);
    div.appendChild(checkbox);
    div.appendChild(folderIcon);
    div.appendChild(nameSpan);
    div.appendChild(countBadge);
    div.appendChild(settingsBtn);
    div.appendChild(delBtn);

    // Folder content (child groups + items)
    const folderContent = document.createElement('div');
    folderContent.className = 'folder-content';

    // Render child groups recursively
    if (group.child_groups && group.child_groups.length > 0) {
        group.child_groups.forEach(child => {
            const childDiv = createGroupItem(child, type, depth + 1);
            folderContent.appendChild(childDiv);
        });
    }

    // Render items in this group
    let groupItems;
    if (type === 'asset') {
        groupItems = assets.filter(a => a.layer_group === group.id);
    } else if (type === 'sheet') {
        groupItems = sheets.filter(s => s.layer_group === group.id);
    } else if (type === 'measurement') {
        // Get measurements from MeasurementTool
        const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];
        groupItems = savedMeasurements.filter(m => m.layer_group === group.id);
    } else {
        groupItems = links.filter(l => l.layer_group === group.id);
    }
    
    groupItems.forEach(item => {
        const itemDiv = type === 'sheet' 
            ? createSheetItem(item) 
            : createFolderItemElement(item, type);
        folderContent.appendChild(itemDiv);
    });

    div.appendChild(folderContent);

    return div;
}

/**
 * Create an item element inside a folder
 */
/**
 * Create a folder item element using the unified ToolSectionItem module
 * This provides consistent UI across all item types (sheets, assets, links, measurements)
 */
function createFolderItemElement(item, type) {
    // Use the unified ToolSectionItem module if available
    if (typeof ToolSectionItem !== 'undefined') {
        return ToolSectionItem.create(item, type);
    }
    
    // Fallback to basic implementation
    const div = document.createElement('div');
    div.className = 'folder-item-entry';
    div.dataset.itemId = item.id;
    div.dataset.itemType = type;
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'item-name';
    nameSpan.textContent = item.name || item.asset_id || item.link_id || 'Unnamed';
    div.appendChild(nameSpan);
    
    return div;
}

/**
 * Show folder settings context menu
 */
function showFolderSettingsMenu(group, type, anchorEl) {
    // Remove any existing menu
    const existingMenu = document.querySelector('.folder-settings-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.className = 'folder-settings-menu';

    // Get ungrouped count based on type
    let ungroupedItems;
    if (type === 'asset') {
        ungroupedItems = assets.filter(a => !a.layer_group);
    } else if (type === 'sheet') {
        ungroupedItems = sheets.filter(s => !s.layer_group);
    } else if (type === 'measurement') {
        const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];
        ungroupedItems = savedMeasurements.filter(m => !m.layer_group);
    } else {
        ungroupedItems = links.filter(l => !l.layer_group);
    }
    
    // Get context-aware item count for this group
    const contextItemCount = getGroupItemCountForType(group, type);

    // Menu options
    const options = [
        {
            label: `Assign all ungrouped (${ungroupedItems.length})`,
            icon: '📥',
            disabled: ungroupedItems.length === 0,
            action: () => assignAllUngroupedToGroup(group.id, type)
        },
        {
            label: 'Rename folder',
            icon: '✏️',
            action: () => renameGroup(group.id, group.name)
        },
        {
            label: 'Change color',
            icon: '🎨',
            action: () => changeGroupColor(group.id, group.color)
        },
        {
            label: 'Create subfolder',
            icon: '📁',
            action: () => createSubfolder(group.id, type)
        },
        { separator: true },
        {
            label: 'Move to another folder',
            icon: '↗️',
            action: () => showMoveGroupDialog(group, type)
        },
        {
            label: 'Ungroup all items',
            icon: '📤',
            disabled: contextItemCount === 0,
            action: () => ungroupAllItems(group.id, type)
        }
    ];

    options.forEach(opt => {
        if (opt.separator) {
            const sep = document.createElement('div');
            sep.className = 'menu-separator';
            menu.appendChild(sep);
        } else {
            const item = document.createElement('div');
            item.className = 'menu-item' + (opt.disabled ? ' disabled' : '');
            item.innerHTML = `<span class="menu-icon">${opt.icon}</span> ${opt.label}`;
            if (!opt.disabled) {
                item.addEventListener('click', () => {
                    menu.remove();
                    opt.action();
                });
            }
            menu.appendChild(item);
        }
    });

    // Position menu near the settings button
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = rect.bottom + 'px';
    menu.style.left = rect.left + 'px';
    menu.style.zIndex = '9999';

    document.body.appendChild(menu);

    // Close on click outside
    const closeHandler = (e) => {
        if (!menu.contains(e.target) && e.target !== anchorEl) {
            menu.remove();
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

/**
 * Assign all ungrouped items to a group
 */
async function assignAllUngroupedToGroup(groupId, type) {
    let items;
    if (type === 'asset') {
        items = assets.filter(a => !a.layer_group);
    } else if (type === 'sheet') {
        items = sheets.filter(s => !s.layer_group);
    } else if (type === 'measurement') {
        const savedMeasurements = MeasurementTool ? MeasurementTool.getSavedMeasurements() : [];
        items = savedMeasurements.filter(m => !m.layer_group);
    } else {
        items = links.filter(l => !l.layer_group);
    }

    if (items.length === 0) return;

    if (!confirm(`Assign ${items.length} ungrouped ${type}s to this folder?`)) return;

    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/assign-ungrouped/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ item_type: type })
        });

        if (resp.ok) {
            await loadProjectData();
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to assign items');
        }
    } catch (err) {
        console.error('Error assigning ungrouped items:', err);
        alert('Error assigning items');
    }
}

/**
 * Remove an item from its group (make it ungrouped)
 */
async function removeItemFromGroup(itemType, itemId) {
    try {
        let endpoint;
        if (itemType === 'asset') {
            endpoint = 'assets';
        } else if (itemType === 'sheet') {
            endpoint = 'sheets';
        } else {
            endpoint = 'links';
        }
        const resp = await fetch(`/api/${endpoint}/${itemId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ layer_group: null })
        });

        if (resp.ok) {
            await loadProjectData();
        }
    } catch (err) {
        console.error('Error removing item from group:', err);
    }
}

/**
 * Rename a group
 */
async function renameGroup(groupId, currentName) {
    const newName = prompt('Enter new folder name:', currentName);
    if (!newName || newName === currentName) return;

    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ name: newName })
        });

        if (resp.ok) {
            await loadLayerGroups();
        }
    } catch (err) {
        console.error('Error renaming group:', err);
    }
}

/**
 * Change group color
 */
async function changeGroupColor(groupId, currentColor) {
    const newColor = prompt('Enter color (hex, e.g., #3498db):', currentColor || '#3498db');
    if (!newColor) return;

    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ color: newColor })
        });

        if (resp.ok) {
            await loadLayerGroups();
        }
    } catch (err) {
        console.error('Error changing group color:', err);
    }
}

/**
 * Create a subfolder under a parent group
 */
async function createSubfolder(parentId, type) {
    const name = prompt('Enter subfolder name:');
    if (!name) return;

    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/layer-groups/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({
                name: name,
                group_type: type,
                parent_group: parentId
            })
        });

        if (resp.ok) {
            await loadLayerGroups();
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to create subfolder');
        }
    } catch (err) {
        console.error('Error creating subfolder:', err);
    }
}

/**
 * Show dialog to move a group to another parent
 */
function showMoveGroupDialog(group, type) {
    // Get type-specific groups
    let typeGroups;
    if (type === 'asset') {
        typeGroups = assetGroups;
    } else if (type === 'link') {
        typeGroups = linkGroups;
    } else if (type === 'sheet') {
        typeGroups = sheetGroups;
    } else if (type === 'measurement') {
        typeGroups = measurementGroups;
    } else {
        typeGroups = [];
    }
    
    // Get all Global folders (any type) that could accept this folder
    const globalFolders = getAllGlobalGroups().filter(g => 
        g.id !== group.id && 
        g.id !== group.parent_group &&
        !isDescendantOf(g, group) // Don't allow moving to own descendants
    );
    
    // Combine type-specific folders + global folders, removing duplicates
    const allFolders = [...typeGroups];
    globalFolders.forEach(gf => {
        if (!allFolders.some(f => f.id === gf.id)) {
            allFolders.push(gf);
        }
    });
    
    // Filter out the current group and its current parent
    const availableParents = allFolders.filter(g => 
        g.id !== group.id && 
        g.id !== group.parent_group &&
        !isDescendantOf(g, group)
    );

    if (availableParents.length === 0) {
        alert('No other folders available to move to.');
        return;
    }

    // Build options list with indicators for global folders
    const options = ['(Root level - no parent)', ...availableParents.map(g => {
        const prefix = g.scope === 'global' ? '🌐 ' : '📁 ';
        return prefix + g.name;
    })];
    const choice = prompt(`Move "${group.name}" to:\n\n${options.map((o, i) => `${i}: ${o}`).join('\n')}\n\nEnter number:`);
    
    if (choice === null) return;
    const idx = parseInt(choice);
    if (isNaN(idx) || idx < 0 || idx >= options.length) {
        alert('Invalid selection');
        return;
    }

    const newParentId = idx === 0 ? null : availableParents[idx - 1].id;
    moveGroupToParent(group.id, newParentId);
}

/**
 * Move a group to a new parent
 */
async function moveGroupToParent(groupId, newParentId) {
    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ parent_group: newParentId })
        });

        if (resp.ok) {
            await loadLayerGroups();
        }
    } catch (err) {
        console.error('Error moving group:', err);
    }
}

/**
 * Ungroup all items in a group (move to ungrouped)
 */
async function ungroupAllItems(groupId, type) {
    if (!confirm('Remove all items from this folder? They will become ungrouped.')) return;

    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/ungroup-all/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            }
        });

        if (resp.ok) {
            await loadProjectData();
        }
    } catch (err) {
        console.error('Error ungrouping items:', err);
    }
}

/**
 * Toggle visibility of a specific layer group
 */
async function toggleLayerGroupVisibility(groupId, visible) {
    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/toggle-visibility/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ visible })
        });

        if (resp.ok) {
            groupVisibility[groupId] = visible;
            // Re-render assets and links to reflect visibility change
            clearAssetsFromCanvas();
            clearLinksFromCanvas();
            renderAssetsOnCanvas();
            renderLinksOnCanvas();
        }
    } catch (err) {
        console.error('Error toggling group visibility:', err);
    }
}

/**
 * Show dialog to join a group to another
 */
function showJoinGroupDialog(group, type) {
    const groups = type === 'asset' ? assetGroups : linkGroups;
    const otherGroups = groups.filter(g => g.id !== group.id && !g.parent_group);

    if (otherGroups.length === 0) {
        alert('No other groups available to join to.');
        return;
    }

    const groupNames = otherGroups.map(g => g.name).join('\n');
    const parentName = prompt(`Join "${group.name}" to which group?\n\nAvailable groups:\n${groupNames}`);
    if (!parentName) return;

    const parent = otherGroups.find(g => g.name.toLowerCase() === parentName.toLowerCase());
    if (!parent) {
        alert('Group not found');
        return;
    }

    joinGroups(parent.id, group.id);
}

/**
 * Join one group to another
 */
async function joinGroups(parentId, childId) {
    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/layer-groups/join/`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ parent_id: parentId, child_id: childId })
        });

        if (resp.ok) {
            await loadLayerGroups();  // Refresh groups
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to join groups');
        }
    } catch (err) {
        console.error('Error joining groups:', err);
    }
}

/**
 * Unjoin a group from its parent
 */
async function unjoinGroup(groupId) {
    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/unjoin/`, {
            method: 'POST',
            headers: {
                'X-CSRFToken': getCSRFToken()
            }
        });

        if (resp.ok) {
            await loadLayerGroups();  // Refresh groups
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to unjoin group');
        }
    } catch (err) {
        console.error('Error unjoining group:', err);
    }
}

/**
 * Delete a layer group
 */
async function deleteLayerGroup(groupId, groupName) {
    if (!confirm(`Delete group "${groupName}" and all its items?`)) return;

    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/`, {
            method: 'DELETE',
            headers: {
                'X-CSRFToken': getCSRFToken()
            }
        });

        if (resp.ok) {
            await loadLayerGroups();
            // Reload assets and links as items may have been deleted
            await loadProjectData();
        }
    } catch (err) {
        console.error('Error deleting group:', err);
    }
}

/**
 * Move an item (asset or link) to a different group
 */
async function moveItemToGroup(groupId, itemType, itemId) {
    try {
        const resp = await fetch(`/api/layer-groups/${groupId}/move-item/`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': getCSRFToken()
            },
            body: JSON.stringify({ item_type: itemType, item_id: itemId })
        });

        if (resp.ok) {
            // Refresh data
            await loadLayerGroups();
            await loadProjectData();
        } else {
            const data = await resp.json();
            alert(data.error || 'Failed to move item');
        }
    } catch (err) {
        console.error('Error moving item to group:', err);
    }
}

/**
 * Clear all asset objects from canvas
 */
function clearAssetsFromCanvas() {
    const assetObjs = canvas.getObjects().filter(obj => obj.assetData);
    assetObjs.forEach(obj => canvas.remove(obj));
}

/**
 * Clear all link objects from canvas
 */
function clearLinksFromCanvas() {
    const linkObjs = canvas.getObjects().filter(obj => obj.isLinkObject);
    linkObjs.forEach(obj => canvas.remove(obj));
}

// ==================== Measurement Sets ====================

/**
 * Load saved measurement sets
 */
async function loadMeasurementSets() {
    try {
        const resp = await fetch(`/api/projects/${PROJECT_ID}/measurement-sets/`);
        if (resp.ok) {
            measurementSets = await resp.json();
            renderMeasurementSetsUI();
        }
    } catch (err) {
        console.error('Error loading measurement sets:', err);
    }
}

/**
 * Render measurement sets list in the sidebar
 */
function renderMeasurementSetsUI() {
    const container = document.getElementById('measurement-sets-list');
    if (!container) return;

    container.innerHTML = '';

    if (measurementSets.length === 0) {
        container.innerHTML = '<p class="text-muted small">No saved measurements</p>';
        return;
    }

    measurementSets.forEach(ms => {
        const div = document.createElement('div');
        div.className = 'measurement-set-item d-flex align-items-center py-1 px-2 border-bottom';
        div.dataset.measurementId = ms.id;

        // Visibility checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = ms.visible;
        checkbox.className = 'ms-visibility me-2';
        checkbox.title = 'Toggle measurement visibility';
        checkbox.addEventListener('change', () => toggleMeasurementSetVisibility(ms.id, checkbox.checked));

        // Color indicator
        const colorDot = document.createElement('span');
        colorDot.style.cssText = `
            display: inline-block;
            width: 12px;
            height: 12px;
            border-radius: 2px;
            background-color: ${ms.color || '#00bcd4'};
            margin-right: 8px;
            flex-shrink: 0;
        `;

        // Name
        const nameSpan = document.createElement('span');
        nameSpan.className = 'text-truncate flex-grow-1';
        nameSpan.textContent = ms.name;

        // Type badge
        const typeBadge = document.createElement('span');
        typeBadge.className = 'badge ms-1';
        typeBadge.className += ms.measurement_type === 'chain' ? ' bg-warning' : ' bg-info';
        typeBadge.textContent = ms.measurement_type;
        typeBadge.style.fontSize = '0.65em';

        // Distance display
        const distSpan = document.createElement('span');
        distSpan.className = 'small text-muted ms-1';
        if (ms.total_distance_meters) {
            distSpan.textContent = `${ms.total_distance_meters.toFixed(2)}m`;
        } else if (ms.total_distance_pixels) {
            distSpan.textContent = `${ms.total_distance_pixels.toFixed(0)}px`;
        }

        // View button
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-sm btn-outline-primary ms-1';
        viewBtn.style.padding = '0 4px';
        viewBtn.style.fontSize = '0.7em';
        viewBtn.textContent = '👁';
        viewBtn.title = 'Show on canvas';
        viewBtn.addEventListener('click', () => showMeasurementSetOnCanvas(ms));

        // Delete button
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-outline-danger ms-1';
        delBtn.style.padding = '0 4px';
        delBtn.style.fontSize = '0.7em';
        delBtn.textContent = '×';
        delBtn.title = 'Delete measurement';
        delBtn.addEventListener('click', () => deleteMeasurementSet(ms.id, ms.name));

        div.appendChild(checkbox);
        div.appendChild(colorDot);
        div.appendChild(nameSpan);
        div.appendChild(typeBadge);
        div.appendChild(distSpan);
        div.appendChild(viewBtn);
        div.appendChild(delBtn);

        container.appendChild(div);
    });
}

/**
 * Toggle visibility of a measurement set
 */
async function toggleMeasurementSetVisibility(msId, visible) {
    // Now uses MeasurementTool.toggleVisibility()
    return await MeasurementTool.toggleVisibility(msId, visible);
}

/**
 * Show a measurement set on the canvas
 */
function showMeasurementSetOnCanvas(ms) {
    if (!ms.points || ms.points.length === 0) return;

    // Clear existing measurement preview
    clearMeasurementOverlays();

    // Draw the measurement on canvas
    const color = ms.color || '#00bcd4';
    const points = ms.points;

    if (points.length === 1) {
        // Single point
        const marker = new fabric.Circle({
            left: points[0].x,
            top: points[0].y,
            radius: 6,
            fill: color,
            stroke: '#fff',
            strokeWidth: 2,
            originX: 'center',
            originY: 'center',
            selectable: false,
            evented: false,
            isMeasurementOverlay: true
        });
        canvas.add(marker);
    } else {
        // Draw lines between points
        for (let i = 0; i < points.length - 1; i++) {
            const line = new fabric.Line(
                [points[i].x, points[i].y, points[i + 1].x, points[i + 1].y],
                {
                    stroke: color,
                    strokeWidth: 2,
                    selectable: false,
                    evented: false,
                    isMeasurementOverlay: true
                }
            );
            canvas.add(line);
        }

        // Draw point markers
        points.forEach((pt, idx) => {
            const marker = new fabric.Circle({
                left: pt.x,
                top: pt.y,
                radius: idx === 0 || idx === points.length - 1 ? 6 : 4,
                fill: idx === 0 ? '#00ff00' : (idx === points.length - 1 ? '#ff0000' : color),
                stroke: '#fff',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false,
                isMeasurementOverlay: true
            });
            canvas.add(marker);
        });

        // Add distance label at midpoint of last segment
        if (ms.total_distance_meters || ms.total_distance_pixels) {
            const lastPt = points[points.length - 1];
            const prevPt = points[points.length - 2];
            const midX = (lastPt.x + prevPt.x) / 2;
            const midY = (lastPt.y + prevPt.y) / 2;
            const distText = ms.total_distance_meters
                ? `${ms.total_distance_meters.toFixed(2)}m`
                : `${ms.total_distance_pixels.toFixed(0)}px`;

            const label = new fabric.Text(distText, {
                left: midX + 10,
                top: midY - 10,
                fontSize: 12,
                fill: color,
                backgroundColor: 'rgba(255,255,255,0.8)',
                selectable: false,
                evented: false,
                isMeasurementOverlay: true
            });
            canvas.add(label);
        }
    }

    canvas.renderAll();
}

/**
 * Render all visible saved measurements on canvas
 */
function renderSavedMeasurementsOnCanvas() {
    // Clear existing measurement overlays (but not the active measurement tool overlays)
    const savedOverlays = canvas.getObjects().filter(obj => obj.isSavedMeasurement);
    savedOverlays.forEach(obj => canvas.remove(obj));

    // Draw each visible measurement set
    measurementSets.filter(ms => ms.visible).forEach(ms => {
        if (!ms.points || ms.points.length === 0) return;

        const color = ms.color || '#00bcd4';
        const points = ms.points;

        if (points.length >= 2) {
            // Draw lines
            for (let i = 0; i < points.length - 1; i++) {
                const line = new fabric.Line(
                    [points[i].x, points[i].y, points[i + 1].x, points[i + 1].y],
                    {
                        stroke: color,
                        strokeWidth: 2,
                        strokeDashArray: [5, 5],
                        selectable: false,
                        evented: false,
                        isSavedMeasurement: true,
                        measurementSetId: ms.id
                    }
                );
                canvas.add(line);
                // Don't send to back - keep measurements visible on top
            }
        }

        // Draw point markers
        points.forEach((pt, idx) => {
            const marker = new fabric.Circle({
                left: pt.x,
                top: pt.y,
                radius: 4,
                fill: color,
                stroke: '#fff',
                strokeWidth: 1,
                originX: 'center',
                originY: 'center',
                selectable: false,
                evented: false,
                isSavedMeasurement: true,
                measurementSetId: ms.id
            });
            canvas.add(marker);
        });
    });

    // Ensure saved measurements are on top
    bringMeasurementsToFront();
    canvas.renderAll();
}

/**
 * Save current measurement as a measurement set
 */
/**
 * Prompt user for measurement name and save
 */
function saveMeasurementPrompt() {
    // Show modal instead of prompt
    showSaveMeasurementModal();
}

function showSaveMeasurementModal() {
    const modal = document.getElementById('saveMeasurementModal');
    const folderSelect = document.getElementById('measurement-folder');
    const nameInput = document.getElementById('measurement-name');
    
    if (!modal) return;
    
    // Clear and populate folder options
    folderSelect.innerHTML = '<option value="">Ungrouped</option>';
    
    // Add measurement groups if they exist
    const measurementGroups = PROJECT_DATA.measurementGroups || [];
    measurementGroups.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        folderSelect.appendChild(opt);
    });
    
    nameInput.value = '';
    modal.style.display = 'flex';
    nameInput.focus();
}

function hideSaveMeasurementModal() {
    const modal = document.getElementById('saveMeasurementModal');
    if (modal) modal.style.display = 'none';
}

// Handle save measurement form submission
document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('saveMeasurementForm');
    if (form) {
        form.addEventListener('submit', async function(e) {
            e.preventDefault();
            const name = document.getElementById('measurement-name').value.trim();
            const folderId = document.getElementById('measurement-folder').value;
            
            if (!name) {
                console.error('Measurement name is required');
                return;
            }
            
            console.log('Saving measurement:', { name, folderId });
            const success = await MeasurementTool.saveCurrent(name, folderId || null);
            
            if (success) {
                hideSaveMeasurementModal();
                await renderMeasurementGroupList();
            }
        });
    }
});

async function saveCurrentMeasurement() {
    // Legacy wrapper - now uses MeasurementTool
    return saveMeasurementPrompt();
}

// ==================== Measurement Config Modal ====================

function showMeasurementConfigModal() {
    const modal = document.getElementById('measurementConfigModal');
    if (!modal) return;
    
    // Get current config from MeasurementTool
    const config = MeasurementTool.getConfig();
    
    // Populate display settings
    document.getElementById('config-show-distance').checked = config.showDistance !== false;
    document.getElementById('config-show-angle').checked = config.showAngle !== false;
    document.getElementById('config-label-scale').value = config.labelScale || 1;
    document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
    
    // Populate line style settings
    document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
    document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
    document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
    document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
    document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
    
    // Populate marker settings
    if (document.getElementById('config-marker-size')) {
        document.getElementById('config-marker-size').value = config.markerSize || 4;
        document.getElementById('config-marker-value').textContent = config.markerSize || 4;
    }
    
    // Refresh presets list
    refreshConfigTypesList();
    
    // Show style tab by default (matches HTML active state)
    switchConfigTab('style');
    
    modal.style.display = 'flex';
}

function hideMeasurementConfigModal() {
    const modal = document.getElementById('measurementConfigModal');
    if (modal) modal.style.display = 'none';
}

function switchConfigTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.config-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    
    // Update tab panels
    document.querySelectorAll('.config-tab-content').forEach(panel => {
        const isActive = panel.id === `config-tab-${tabName}`;
        panel.style.display = isActive ? 'block' : 'none';
    });
}

// Alias for HTML compatibility
function switchMeasureConfigTab(tabName) {
    switchConfigTab(tabName);
}

function saveMeasurementConfig() {
    const lineStyle = document.getElementById('config-line-style').value || 'dashed';
    const lineThickness = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
    const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
    
    const config = {
        showDistance: document.getElementById('config-show-distance').checked,
        showAngle: document.getElementById('config-show-angle').checked,
        labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
        lineStyle: lineStyle,
        lineStrokeWidth: lineThickness,
        lineColor: document.getElementById('config-line-color').value || '#00bcd4',
        markerColor: document.getElementById('config-line-color').value || '#00bcd4',
        markerSize: markerSize,
        previewLineColor: document.getElementById('config-line-color').value || '#00bcd4'
    };
    
    // Update dash array based on style
    config.lineDashArray = MeasurementTool.getLineDashArray(config.lineStyle, config.lineStrokeWidth);
    
    MeasurementTool.updateConfig(config);
    hideMeasurementConfigModal();
    
    console.log('Measurement config saved:', config);
}

function refreshConfigTypesList() {
    const container = document.getElementById('config-presets-list');
    if (!container) return;
    
    const configTypes = MeasurementTool.getConfigTypes();
    const currentType = MeasurementTool.getCurrentConfigType();
    container.innerHTML = '';
    
    // configTypes is an object with keys like 'default', 'typeA', etc.
    Object.entries(configTypes).forEach(([key, ct]) => {
        const item = document.createElement('div');
        item.className = 'config-type-item';
        if (key === currentType) {
            item.classList.add('active');
        }
        
        const cfg = ct.config || {};
        item.innerHTML = `
            <span class="config-type-name">${ct.name || key}</span>
            <div class="config-type-actions">
                <button type="button" class="btn-apply" onclick="applyConfigType('${key}')">Apply</button>
                <button type="button" class="btn-edit" onclick="editConfigType('${key}')">Edit</button>
                ${key !== 'default' ? `<button type="button" class="btn-delete-config" onclick="deleteConfigTypeHandler('${key}')">×</button>` : ''}
            </div>
        `;
        
        // Add color preview
        const preview = document.createElement('span');
        preview.className = 'config-type-preview';
        const lineColor = cfg.lineColor || '#00bcd4';
        const lineStyle = cfg.lineStyle || 'dashed';
        let bgStyle = `background-color: ${lineColor};`;
        if (lineStyle === 'dashed') {
            bgStyle = `background: repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 5px, transparent 5px, transparent 10px);`;
        } else if (lineStyle === 'dotted') {
            bgStyle = `background: repeating-linear-gradient(90deg, ${lineColor} 0px, ${lineColor} 2px, transparent 2px, transparent 5px);`;
        }
        preview.style.cssText = `
            display: inline-block;
            width: 20px;
            height: 3px;
            ${bgStyle}
            margin-right: 8px;
            vertical-align: middle;
        `;
        item.querySelector('.config-type-name').prepend(preview);
        
        container.appendChild(item);
    });
}

function applyConfigType(name) {
    MeasurementTool.setConfigType(name);
    
    // Update form fields with applied config
    const config = MeasurementTool.getConfig();
    document.getElementById('config-show-distance').checked = config.showDistance !== false;
    document.getElementById('config-show-angle').checked = config.showAngle !== false;
    document.getElementById('config-label-scale').value = config.labelScale || 1;
    document.getElementById('config-scale-value').textContent = (config.labelScale || 1).toFixed(1);
    document.getElementById('config-line-style').value = config.lineStyle || 'dashed';
    document.getElementById('config-line-thickness').value = config.lineStrokeWidth || 1.5;
    document.getElementById('config-thickness-value').textContent = config.lineStrokeWidth || 1.5;
    document.getElementById('config-line-color').value = config.lineColor || '#00bcd4';
    document.getElementById('config-line-color-hex').value = config.lineColor || '#00bcd4';
    if (document.getElementById('config-marker-size')) {
        document.getElementById('config-marker-size').value = config.markerSize || 4;
        document.getElementById('config-marker-value').textContent = config.markerSize || 4;
    }
    
    // Update the list to show active state
    refreshConfigTypesList();
    
    console.log('Applied config type:', name);
}

function addNewConfigType() {
    const nameInput = document.getElementById('config-new-preset-name');
    const name = nameInput ? nameInput.value.trim() : prompt('Enter name for new measurement type:');
    if (!name) return;
    
    // Create a key from the name (lowercase, no spaces)
    const key = name.toLowerCase().replace(/\s+/g, '_');
    
    // Get current settings as the new type's settings
    const lineStyle = document.getElementById('config-line-style').value || 'dashed';
    const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
    const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
    
    const settings = {
        showDistance: document.getElementById('config-show-distance').checked,
        showAngle: document.getElementById('config-show-angle').checked,
        labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
        lineStyle: lineStyle,
        lineStrokeWidth: lineStrokeWidth,
        lineColor: document.getElementById('config-line-color').value || '#00bcd4',
        markerColor: document.getElementById('config-line-color').value || '#00bcd4',
        markerSize: markerSize,
        previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
        lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
    };
    
    // Check if key already exists
    const existingTypes = MeasurementTool.getConfigTypes();
    if (existingTypes[key]) {
        alert('A config type with that name already exists.');
        return;
    }
    
    MeasurementTool.saveConfigType(key, name, settings);
    refreshConfigTypesList();
    if (nameInput) nameInput.value = '';
    console.log('Added new config type:', key, name);
}

function editConfigType(key) {
    // Apply this type first so user can see/edit its settings
    applyConfigType(key);
    
    // Switch to line style tab for editing
    switchConfigTab('style');
    
    // Store the type being edited
    window._editingConfigType = key;
    
    // Get the display name
    const configTypes = MeasurementTool.getConfigTypes();
    const displayName = configTypes[key]?.name || key;
    
    // Change save button text temporarily
    const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
    if (saveBtn) {
        saveBtn.textContent = `Update "${displayName}"`;
        saveBtn.onclick = function() {
            saveAndUpdateConfigType();
        };
    }
}

function saveAndUpdateConfigType() {
    const key = window._editingConfigType;
    if (key) {
        const configTypes = MeasurementTool.getConfigTypes();
        const displayName = configTypes[key]?.name || key;
        
        const lineStyle = document.getElementById('config-line-style').value || 'dashed';
        const lineStrokeWidth = parseFloat(document.getElementById('config-line-thickness').value) || 1.5;
        const markerSize = parseInt(document.getElementById('config-marker-size').value) || 4;
        
        const settings = {
            showDistance: document.getElementById('config-show-distance').checked,
            showAngle: document.getElementById('config-show-angle').checked,
            labelScale: parseFloat(document.getElementById('config-label-scale').value) || 1,
            lineStyle: lineStyle,
            lineStrokeWidth: lineStrokeWidth,
            lineColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerColor: document.getElementById('config-line-color').value || '#00bcd4',
            markerSize: markerSize,
            previewLineColor: document.getElementById('config-line-color').value || '#00bcd4',
            lineDashArray: MeasurementTool.getLineDashArray(lineStyle, lineStrokeWidth)
        };
        
        MeasurementTool.saveConfigType(key, displayName, settings);
        refreshConfigTypesList();
        console.log('Updated config type:', key);
    }
    
    // Reset state
    window._editingConfigType = null;
    const saveBtn = document.querySelector('#measurementConfigModal .btn-save');
    if (saveBtn) {
        saveBtn.textContent = 'Save Settings';
        saveBtn.onclick = saveMeasurementConfig;
    }
    
    // Apply and close
    saveMeasurementConfig();
}

function deleteConfigTypeHandler(key) {
    const configTypes = MeasurementTool.getConfigTypes();
    const displayName = configTypes[key]?.name || key;
    
    if (!confirm(`Delete measurement type "${displayName}"?`)) return;
    
    MeasurementTool.deleteConfigType(key);
    refreshConfigTypesList();
    console.log('Deleted config type:', key);
}

// Initialize config tab click handlers
document.addEventListener('DOMContentLoaded', function() {
    // Tab button event listeners now handled via onclick attributes in HTML
    
    // Slider value displays - sync color input with hex text
    const lineColorInput = document.getElementById('config-line-color');
    const lineColorHex = document.getElementById('config-line-color-hex');
    if (lineColorInput && lineColorHex) {
        lineColorInput.addEventListener('input', function() {
            lineColorHex.value = this.value;
        });
    }
});

/**
 * Delete a measurement set
 */
async function deleteMeasurementSet(msId, name) {
    // Now uses MeasurementTool.delete()
    return await MeasurementTool.delete(msId, name);
}

/**
 * Clear measurement overlays from canvas
 */
function clearMeasurementOverlays() {
    const overlays = canvas.getObjects().filter(obj => obj.isMeasurementOverlay);
    overlays.forEach(obj => canvas.remove(obj));
    canvas.renderAll();
}


// ==================== Dark Mode & PDF Inversion ====================

function applyCanvasTheme() {
    if (!canvas) return;
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    canvas.backgroundColor = isDark ? '#2a2a3a' : '#e0e0e0';
    canvas.renderAll();
}

/**
 * Apply filters and ensure image dimensions are preserved.
 * Resets _filterScalingX/Y to 1 and logs diagnostics if the filtered
 * element dimensions don't match the image's logical dimensions.
 */
function applyFiltersPreservingSize(img) {
    var wBefore = img.width, hBefore = img.height;
    img.applyFilters();
    var el = img._element;
    var elW = el ? (el.naturalWidth || el.width) : 0;
    var elH = el ? (el.naturalHeight || el.height) : 0;
    if (elW !== wBefore || elH !== hBefore || img._filterScalingX !== 1 || img._filterScalingY !== 1) {
        console.warn('[applyFiltersPreservingSize] dimension mismatch:',
            'img.width=' + wBefore, 'img.height=' + hBefore,
            'el.width=' + elW, 'el.height=' + elH,
            '_filterScalingX=' + img._filterScalingX, '_filterScalingY=' + img._filterScalingY);
    }
    img._filterScalingX = 1;
    img._filterScalingY = 1;
}

function applyPdfInversion() {
    if (!canvas) return;
    canvas.getObjects().filter(function(obj) { return obj.sheetData; }).forEach(function(img) {
        if (!img.filters) img.filters = [];
        if (isPdfInverted) {
            if (!img.filters.some(function(f) { return f.type === 'Invert'; })) {
                img.filters.push(new fabric.Image.filters.Invert());
            }
        } else {
            img.filters = img.filters.filter(function(f) { return f.type !== 'Invert'; });
        }
        applyFiltersPreservingSize(img);
        img.dirty = true;
    });
    canvas.renderAll();
}


// ==================== Layer Section Sorting ====================

let draggedSection = null;

function initLayerSectionSorting() {
    const container = document.getElementById('layers-container');
    if (!container) return;
    
    const sections = container.querySelectorAll('.sortable-layer-section');
    
    sections.forEach(section => {
        const handle = section.querySelector('.drag-handle');
        if (!handle) return;
        
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            draggedSection = section;
            section.classList.add('dragging');
            
            document.addEventListener('mousemove', onDragMove);
            document.addEventListener('mouseup', onDragEnd);
        });
        
        section.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (draggedSection && draggedSection !== section) {
                section.classList.add('drag-over');
            }
        });
        
        section.addEventListener('dragleave', () => {
            section.classList.remove('drag-over');
        });
    });
    
    // Restore saved order
    restoreLayerSectionOrder();
}

function onDragMove(e) {
    if (!draggedSection) return;
    
    const container = document.getElementById('layers-container');
    const sections = [...container.querySelectorAll('.sortable-layer-section')];
    
    // Find section under cursor
    const mouseY = e.clientY;
    let targetSection = null;
    
    for (const section of sections) {
        if (section === draggedSection) continue;
        const rect = section.getBoundingClientRect();
        if (mouseY >= rect.top && mouseY <= rect.bottom) {
            targetSection = section;
            break;
        }
    }
    
    // Clear all drag-over states
    sections.forEach(s => s.classList.remove('drag-over'));
    
    if (targetSection) {
        const targetRect = targetSection.getBoundingClientRect();
        const isAboveMiddle = mouseY < targetRect.top + targetRect.height / 2;
        
        if (isAboveMiddle) {
            targetSection.classList.add('drag-over');
        } else {
            // Add indicator below
            const nextSibling = targetSection.nextElementSibling;
            if (nextSibling && nextSibling.classList.contains('sortable-layer-section')) {
                nextSibling.classList.add('drag-over');
            }
        }
    }
}

function onDragEnd(e) {
    if (!draggedSection) return;
    
    const container = document.getElementById('layers-container');
    const sections = [...container.querySelectorAll('.sortable-layer-section')];
    
    // Find drop target
    const mouseY = e.clientY;
    let targetSection = null;
    let insertBefore = true;
    
    for (const section of sections) {
        if (section === draggedSection) continue;
        const rect = section.getBoundingClientRect();
        if (mouseY >= rect.top && mouseY <= rect.bottom) {
            targetSection = section;
            insertBefore = mouseY < rect.top + rect.height / 2;
            break;
        }
    }
    
    // Clear states
    sections.forEach(s => s.classList.remove('drag-over', 'dragging'));
    
    // Move section
    if (targetSection && targetSection !== draggedSection) {
        if (insertBefore) {
            container.insertBefore(draggedSection, targetSection);
        } else {
            container.insertBefore(draggedSection, targetSection.nextSibling);
        }
        saveLayerSectionOrder();
    }
    
    draggedSection = null;
    document.removeEventListener('mousemove', onDragMove);
    document.removeEventListener('mouseup', onDragEnd);
}

function saveLayerSectionOrder() {
    const container = document.getElementById('layers-container');
    if (!container) return;
    
    const sections = container.querySelectorAll('.sortable-layer-section');
    const order = [...sections].map(s => s.dataset.section);
    
    localStorage.setItem(`docuweaver-layer-order-${PROJECT_ID}`, JSON.stringify(order));
    console.log('Layer section order saved:', order);
}

function restoreLayerSectionOrder() {
    const container = document.getElementById('layers-container');
    if (!container) return;
    
    const savedOrder = localStorage.getItem(`docuweaver-layer-order-${PROJECT_ID}`);
    if (!savedOrder) return;
    
    try {
        const order = JSON.parse(savedOrder);
        const sections = container.querySelectorAll('.sortable-layer-section');
        const sectionMap = {};
        
        sections.forEach(s => {
            sectionMap[s.dataset.section] = s;
        });
        
        // Reorder sections based on saved order
        order.forEach(sectionName => {
            if (sectionMap[sectionName]) {
                container.appendChild(sectionMap[sectionName]);
            }
        });
        
        console.log('Layer section order restored:', order);
    } catch (e) {
        console.warn('Failed to restore layer section order:', e);
    }
}

function moveMeasurementSectionToTop() {
    const container = document.getElementById('layers-container');
    if (!container) return;
    
    const measurementSection = container.querySelector('.sortable-layer-section[data-section="measurements"]');
    if (measurementSection && container.firstChild !== measurementSection) {
        container.insertBefore(measurementSection, container.firstChild);
        saveLayerSectionOrder();
    }
}

// Initialize layer sorting on DOM ready
document.addEventListener('DOMContentLoaded', function() {
    initLayerSectionSorting();
});


// ==================== View State Persistence Hooks ====================

// Hook into zoom and pan to save view state more frequently
function hookViewStateSaving() {
    if (!canvas) return;
    
    // Save on mouse:up after panning
    canvas.on('mouse:up', function() {
        if (currentMode === 'pan') {
            debouncedSaveViewportState();
        }
    });
}

// Save view state before page unload
window.addEventListener('beforeunload', function() {
    saveViewportState();
});
