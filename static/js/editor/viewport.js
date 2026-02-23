/**
 * DocuWeaver Canvas Editor - Viewport Module
 * 
 * Handles zoom, pan, rotation, and viewport state persistence.
 * 
 * Depends on: namespace.js
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // Debounce timers
    let rotationSaveTimeout = null;
    let viewportSaveTimeout = null;
    
    // ==================== Zoom Functions ====================
    
    function zoomIn() {
        let zoom = state.currentZoomLevel * 1.2;
        if (zoom > 5) zoom = 5;
        setZoomPreservingRotation(zoom);
        updateZoomDisplay();
    }
    
    function zoomOut() {
        let zoom = state.currentZoomLevel / 1.2;
        if (zoom < 0.1) zoom = 0.1;
        setZoomPreservingRotation(zoom);
        updateZoomDisplay();
    }
    
    /**
     * Set zoom while preserving the current viewport rotation
     */
    function setZoomPreservingRotation(zoom) {
        const canvas = state.canvas;
        if (!canvas) return;
        
        state.currentZoomLevel = zoom;
        window.currentZoomLevel = zoom; // Legacy sync
        
        const angleRad = state.viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const vpt = canvas.viewportTransform;
        
        // Apply zoom with rotation
        vpt[0] = cos * zoom;
        vpt[1] = sin * zoom;
        vpt[2] = -sin * zoom;
        vpt[3] = cos * zoom;
        
        canvas.setViewportTransform(vpt);
        
        canvas.forEachObject(function(obj) {
            obj.setCoords();
        });
    }
    
    function zoomFit() {
        const canvas = state.canvas;
        const objects = canvas.getObjects().filter(obj => obj.sheetData);
        
        if (objects.length === 0) return;
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        objects.forEach(obj => {
            const bounds = obj.getBoundingRect(true, true);
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.left + bounds.width);
            maxY = Math.max(maxY, bounds.top + bounds.height);
        });
        
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth < 1 || contentHeight < 1) return;
        
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
    
    function bringToScale() {
        const canvas = state.canvas;
        const objects = canvas.getObjects().filter(obj => obj.sheetData);
        
        if (objects.length === 0) {
            DW.showToast('No sheets to fit', 'warning');
            return;
        }
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        objects.forEach(obj => {
            const bounds = obj.getBoundingRect(true, true);
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.left + bounds.width);
            maxY = Math.max(maxY, bounds.top + bounds.height);
        });
        
        const contentWidth = maxX - minX;
        const contentHeight = maxY - minY;
        
        if (contentWidth < 1 || contentHeight < 1) return;
        
        const zoomX = canvas.width / contentWidth * 0.85;
        const zoomY = canvas.height / contentHeight * 0.85;
        let zoom = Math.min(zoomX, zoomY, 2);
        
        setZoomPreservingRotation(zoom);
        
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
        state.canvas.absolutePan({ x: 0, y: 0 });
        applyViewportRotation();
        updateZoomDisplay();
        debouncedSaveViewportState();
    }
    
    function updateZoomDisplay() {
        const zoom = Math.round(state.currentZoomLevel * 100);
        const zoomLevel = document.getElementById('zoom-level');
        const zoomDisplay = document.getElementById('zoom-display');
        
        if (zoomLevel) zoomLevel.textContent = zoom;
        if (zoomDisplay) zoomDisplay.textContent = zoom + '%';
    }
    
    // ==================== Rotation Functions ====================
    
    /**
     * Set viewport rotation to a specific angle
     */
    function setViewportRotation(degrees) {
        state.viewportRotation = ((degrees % 360) + 360) % 360;
        window.viewportRotation = state.viewportRotation; // Legacy sync
        
        applyViewportRotation();
        updateRotationDisplay();
        debouncedSaveRotation();
    }
    
    /**
     * Rotate by a delta amount
     */
    function rotateViewportBy(delta) {
        setViewportRotation(state.viewportRotation + delta);
    }
    
    /**
     * Match the selected sheet's rotation
     */
    function matchSheetRotation() {
        if (!state.selectedSheet) {
            DW.showToast('Select a sheet first', 'warning');
            return;
        }
        setViewportRotation(-state.selectedSheet.rotation);
        console.log('View rotated to match sheet:', state.selectedSheet.name);
    }
    
    /**
     * Reset rotation to 0
     */
    function resetViewportRotation() {
        setViewportRotation(0);
    }
    
    /**
     * Apply the current viewport rotation to the canvas
     */
    function applyViewportRotation() {
        const canvas = state.canvas;
        if (!canvas) return;
        
        const angleRad = state.viewportRotation * Math.PI / 180;
        const cos = Math.cos(angleRad);
        const sin = Math.sin(angleRad);
        
        const vpt = canvas.viewportTransform;
        const currentZoom = state.currentZoomLevel;
        
        const panX = vpt[4];
        const panY = vpt[5];
        
        vpt[0] = cos * currentZoom;
        vpt[1] = sin * currentZoom;
        vpt[2] = -sin * currentZoom;
        vpt[3] = cos * currentZoom;
        vpt[4] = panX;
        vpt[5] = panY;
        
        canvas.setViewportTransform(vpt);
        
        canvas.forEachObject(function(obj) {
            obj.setCoords();
        });
        
        canvas.renderAll();
        
        // Refresh OSM tiles for new viewport
        if (typeof debouncedRefreshOSM === 'function') {
            debouncedRefreshOSM();
        }
    }
    
    function updateRotationDisplay() {
        const displayAngle = Math.round(state.viewportRotation);
        const rotationLevel = document.getElementById('rotation-level');
        const rotationInput = document.getElementById('viewport-rotation');
        
        if (rotationLevel) rotationLevel.textContent = displayAngle;
        if (rotationInput) rotationInput.value = displayAngle;
    }
    
    function debouncedSaveRotation() {
        if (rotationSaveTimeout) clearTimeout(rotationSaveTimeout);
        rotationSaveTimeout = setTimeout(saveViewportRotation, 500);
    }
    
    async function saveViewportRotation() {
        try {
            await fetch(`/api/projects/${PROJECT_ID}/`, {
                method: 'PATCH',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ canvas_rotation: state.viewportRotation })
            });
        } catch (error) {
            console.error('Error saving rotation:', error);
        }
    }
    
    // ==================== Viewport State Persistence ====================
    
    function saveViewportState() {
        const canvas = state.canvas;
        if (!canvas || typeof PROJECT_ID === 'undefined') return;
        
        const vpt = canvas.viewportTransform;
        const viewState = {
            zoom: state.currentZoomLevel,
            panX: vpt[4],
            panY: vpt[5],
            rotation: state.viewportRotation,
            timestamp: Date.now()
        };
        
        const key = `docuweaver-viewport-${PROJECT_ID}`;
        localStorage.setItem(key, JSON.stringify(viewState));
    }
    
    function restoreViewportState() {
        const canvas = state.canvas;
        if (!canvas || typeof PROJECT_ID === 'undefined') return false;
        
        const key = `docuweaver-viewport-${PROJECT_ID}`;
        const saved = localStorage.getItem(key);
        
        if (saved) {
            try {
                const viewState = JSON.parse(saved);
                
                // Restore zoom
                state.currentZoomLevel = viewState.zoom || 1;
                window.currentZoomLevel = state.currentZoomLevel;
                
                // Restore rotation
                state.viewportRotation = viewState.rotation || 0;
                window.viewportRotation = state.viewportRotation;
                
                // Apply rotation first
                applyViewportRotation();
                
                // Apply pan
                const vpt = canvas.viewportTransform;
                vpt[4] = viewState.panX || 0;
                vpt[5] = viewState.panY || 0;
                canvas.setViewportTransform(vpt);
                
                updateZoomDisplay();
                updateRotationDisplay();
                
                console.log('Viewport restored:', viewState);
                return true;
            } catch (e) {
                console.error('Error restoring viewport:', e);
            }
        }
        
        return false;
    }
    
    function debouncedSaveViewportState() {
        if (viewportSaveTimeout) clearTimeout(viewportSaveTimeout);
        viewportSaveTimeout = setTimeout(saveViewportState, 300);
    }
    
    function hookViewStateSaving() {
        const canvas = state.canvas;
        if (!canvas) return;
        
        canvas.on('mouse:up', function() {
            debouncedSaveViewportState();
        });
    }
    
    // ==================== Cursor Position ====================
    
    function updateCursorPosition(opt) {
        const cursorEl = document.getElementById('cursor-position');
        if (!cursorEl) return;
        
        const canvas = state.canvas;
        const pointer = canvas.getPointer(opt.e);
        const ppm = PROJECT_DATA.pixels_per_meter;
        
        if (!ppm || !isFinite(ppm) || ppm <= 0) {
            cursorEl.textContent = `${pointer.x.toFixed(0)}px, ${pointer.y.toFixed(0)}px`;
            return;
        }
        
        if (typeof pixelToAssetMeter === 'function') {
            const pos = pixelToAssetMeter(pointer.x, pointer.y);
            cursorEl.textContent = `${pos.x.toFixed(2)}m, ${pos.y.toFixed(2)}m`;
        }
    }
    
    // ==================== Public API ====================
    
    DW.viewport = {
        zoomIn,
        zoomOut,
        zoomFit,
        bringToScale,
        resetView,
        setZoomPreservingRotation,
        updateZoomDisplay,
        setViewportRotation,
        rotateViewportBy,
        matchSheetRotation,
        resetViewportRotation,
        applyViewportRotation,
        updateRotationDisplay,
        saveViewportState,
        restoreViewportState,
        debouncedSaveViewportState,
        hookViewStateSaving,
        updateCursorPosition
    };
    
    // Expose globally for backward compatibility
    window.zoomIn = zoomIn;
    window.zoomOut = zoomOut;
    window.zoomFit = zoomFit;
    window.bringToScale = bringToScale;
    window.resetView = resetView;
    window.setZoomPreservingRotation = setZoomPreservingRotation;
    window.updateZoomDisplay = updateZoomDisplay;
    window.setViewportRotation = setViewportRotation;
    window.rotateViewportBy = rotateViewportBy;
    window.matchSheetRotation = matchSheetRotation;
    window.resetViewportRotation = resetViewportRotation;
    window.applyViewportRotation = applyViewportRotation;
    window.updateRotationDisplay = updateRotationDisplay;
    window.saveViewportState = saveViewportState;
    window.restoreViewportState = restoreViewportState;
    window.debouncedSaveViewportState = debouncedSaveViewportState;
    window.hookViewStateSaving = hookViewStateSaving;
    window.updateCursorPosition = updateCursorPosition;
    
    // Save before unload
    window.addEventListener('beforeunload', saveViewportState);
    
    console.log('DocuWeaver viewport module loaded');
})();
