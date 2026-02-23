/**
 * DocuWeaver Canvas Editor - Main Entry Point
 * 
 * Orchestrates initialization of all editor modules.
 * This file should be loaded last after all other modules.
 * 
 * Depends on: All other modules
 */

(function() {
    'use strict';
    
    const DW = window.DocuWeaver;
    const state = DW.state;
    
    // ==================== Data Loading ====================
    
    async function loadProjectData() {
        try {
            const [sheetsResp, assetsResp, linksResp] = await Promise.all([
                fetch(`/api/projects/${PROJECT_ID}/sheets/`),
                fetch(`/api/projects/${PROJECT_ID}/assets/`),
                fetch(`/api/projects/${PROJECT_ID}/links/`)
            ]);

            if (sheetsResp.ok) {
                state.sheets = await sheetsResp.json();
                window.sheets = state.sheets;
            }
            if (assetsResp.ok) {
                state.assets = await assetsResp.json();
                window.assets = state.assets;
            }
            if (linksResp.ok) {
                state.links = await linksResp.json();
                window.links = state.links;
            }

            // Render data on canvas
            renderSheetsOnCanvas();
            renderAssetsOnCanvas();
            renderLinksOnCanvas();
            renderSheetLayers();
            renderAssetList();
            
            // Load OSM if enabled
            if (state.osmEnabled && state.refAssetId) {
                renderOSMLayer();
            }

            // Render saved measurements
            renderSavedMeasurementsOnCanvas();

        } catch (error) {
            console.error('Error loading project data:', error);
        }
    }
    
    async function loadLayerGroups() {
        try {
            const resp = await fetch(`/api/projects/${PROJECT_ID}/layer-groups/`);
            if (resp.ok) {
                state.layerGroups = await resp.json();
                window.layerGroups = state.layerGroups;
                
                // Initialize group visibility
                state.layerGroups.forEach(g => {
                    if (state.groupVisibility[g.id] === undefined) {
                        state.groupVisibility[g.id] = true;
                    }
                });
                window.groupVisibility = state.groupVisibility;
            }
        } catch (err) {
            console.error('Error loading layer groups:', err);
        }
    }
    
    // ==================== Theme ====================
    
    function applyCanvasTheme() {
        if (!state.canvas) return;
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        state.canvas.backgroundColor = isDark ? '#2a2a3a' : '#e0e0e0';
        state.canvas.renderAll();
    }
    
    // ==================== Filter Utilities ====================
    
    function applyFiltersPreservingSize(img) {
        const wBefore = img.width;
        const hBefore = img.height;
        img.applyFilters();
        const el = img._element;
        const elW = el ? (el.naturalWidth || el.width) : 0;
        const elH = el ? (el.naturalHeight || el.height) : 0;
        if (elW !== wBefore || elH !== hBefore || img._filterScalingX !== 1 || img._filterScalingY !== 1) {
            console.warn('[applyFiltersPreservingSize] dimension mismatch');
        }
        img._filterScalingX = 1;
        img._filterScalingY = 1;
    }
    
    function applyPdfInversion() {
        if (!state.canvas) return;
        state.canvas.getObjects().filter(obj => obj.sheetData).forEach(img => {
            if (!img.filters) img.filters = [];
            if (state.isPdfInverted) {
                if (!img.filters.some(f => f.type === 'Invert')) {
                    img.filters.push(new fabric.Image.filters.Invert());
                }
            } else {
                img.filters = img.filters.filter(f => f.type !== 'Invert');
            }
            applyFiltersPreservingSize(img);
            img.dirty = true;
        });
        state.canvas.renderAll();
    }
    
    // ==================== Selection Management ====================
    
    let _clearingSelection = false;
    
    function clearSelection() {
        if (_clearingSelection) return;
        _clearingSelection = true;

        const canvas = state.canvas;

        if (state.showUncutSheetId !== null) {
            const prevObj = canvas.getObjects().find(obj =>
                obj.sheetData && obj.sheetData.id === state.showUncutSheetId
            );
            if (prevObj) {
                prevObj._showUncut = false;
                prevObj.dirty = true;
            }
            state.showUncutSheetId = null;
        }

        state.selectedSheet = null;
        state.selectedAsset = null;
        window.selectedSheet = null;
        window.selectedAsset = null;
        
        canvas.discardActiveObject();

        canvas.getObjects().forEach(obj => {
            if (obj.sheetData) obj.shadow = null;
        });
        canvas.renderAll();
        _clearingSelection = false;

        state.selectedMeasurementId = null;
        document.querySelectorAll('.folder-item-entry.selected-measurement').forEach(el => {
            el.classList.remove('selected-measurement');
        });

        document.querySelectorAll('.layer-item').forEach(item => {
            item.classList.remove('selected');
        });

        document.getElementById('no-selection').style.display = 'block';
        document.getElementById('sheet-properties').style.display = 'none';
        document.getElementById('asset-properties').style.display = 'none';
        
        if (typeof updateContextTools === 'function') {
            updateContextTools();
        }
    }
    
    function updateContextTools() {
        const hasSheet = !!state.selectedSheet;
        const hasCut = hasSheet && state.sheetCutData[state.selectedSheet.id] && 
                       state.sheetCutData[state.selectedSheet.id].length > 0;

        const flipBtn = document.getElementById('ftool-flip');
        const clearCutBtn = document.getElementById('ftool-clear-cut');
        const showUncutBtn = document.getElementById('ftool-show-uncut');

        if (flipBtn) flipBtn.style.display = hasSheet ? 'flex' : 'none';
        if (clearCutBtn) clearCutBtn.style.display = hasSheet ? 'flex' : 'none';
        if (showUncutBtn) showUncutBtn.style.display = (hasSheet && hasCut) ? 'flex' : 'none';

        if (showUncutBtn) {
            showUncutBtn.classList.toggle('active', 
                state.showUncutSheetId === (state.selectedSheet && state.selectedSheet.id));
        }
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
        
        restoreLayerSectionOrder();
    }
    
    function onDragMove(e) {
        if (!draggedSection) return;
        
        const container = document.getElementById('layers-container');
        const sections = [...container.querySelectorAll('.sortable-layer-section')];
        
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
        
        sections.forEach(s => s.classList.remove('drag-over'));
        
        if (targetSection) {
            const targetRect = targetSection.getBoundingClientRect();
            const isAboveMiddle = mouseY < targetRect.top + targetRect.height / 2;
            
            if (isAboveMiddle) {
                targetSection.classList.add('drag-over');
            } else {
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
        
        sections.forEach(s => s.classList.remove('drag-over', 'dragging'));
        
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
    
    // ==================== Group Visibility ====================
    
    function toggleLayerGroup(groupName) {
        const body = document.getElementById(groupName + '-group-body');
        const chevron = document.getElementById(groupName + '-chevron');
        if (body) body.classList.toggle('collapsed');
        if (chevron) chevron.classList.toggle('collapsed');
    }
    
    function toggleGroupVisibility(groupName, visible) {
        const canvas = state.canvas;
        
        if (groupName === 'sheets') {
            canvas.getObjects().forEach(obj => {
                if (obj.sheetData) obj.visible = visible;
            });
            document.querySelectorAll('#sheet-layers .layer-visibility').forEach(cb => {
                cb.checked = visible;
            });
        } else if (groupName === 'assets') {
            canvas.getObjects().forEach(obj => {
                if (obj.assetData) obj.visible = visible;
            });
            document.querySelectorAll('#import-batches .batch-visibility').forEach(cb => {
                cb.checked = visible;
            });
        } else if (groupName === 'links') {
            canvas.getObjects().forEach(obj => {
                if (obj.isLinkObject) obj.visible = visible;
            });
        } else if (groupName === 'measurements') {
            canvas.getObjects().forEach(obj => {
                if (obj.measurementData || obj.isMeasurement) obj.visible = visible;
            });
        }
        canvas.renderAll();
    }
    
    function toggleBatchVisibility(batchId, visible) {
        state.canvas.getObjects().forEach(obj => {
            if (obj.assetData && obj.assetData.import_batch === batchId) {
                obj.visible = visible;
            }
        });
        state.canvas.renderAll();
    }
    
    // ==================== Initialization ====================
    
    async function initEditor() {
        console.log('Initializing DocuWeaver Editor...');
        
        // Initialize canvas
        if (typeof DW.canvas !== 'undefined' && DW.canvas.init) {
            DW.canvas.init();
        }
        
        // Apply theme
        applyCanvasTheme();
        
        // Load layer groups first
        await loadLayerGroups();
        
        // Load project data
        await loadProjectData();
        
        // Load measurement sets
        if (typeof loadMeasurementSets === 'function') {
            await loadMeasurementSets();
        }
        
        // Restore viewport state
        if (typeof restoreViewportState === 'function') {
            restoreViewportState();
        }
        
        // Hook view state saving
        if (typeof hookViewStateSaving === 'function') {
            hookViewStateSaving();
        }
        
        // Initialize layer section sorting
        initLayerSectionSorting();
        
        console.log('DocuWeaver Editor initialized');
    }
    
    // ==================== Public API ====================
    
    DW.main = {
        loadProjectData,
        loadLayerGroups,
        applyCanvasTheme,
        applyFiltersPreservingSize,
        applyPdfInversion,
        clearSelection,
        updateContextTools,
        initLayerSectionSorting,
        saveLayerSectionOrder,
        restoreLayerSectionOrder,
        toggleLayerGroup,
        toggleGroupVisibility,
        toggleBatchVisibility,
        initEditor
    };
    
    // Expose globally for backward compatibility
    window.loadProjectData = loadProjectData;
    window.loadLayerGroups = loadLayerGroups;
    window.applyCanvasTheme = applyCanvasTheme;
    window.applyFiltersPreservingSize = applyFiltersPreservingSize;
    window.applyPdfInversion = applyPdfInversion;
    window.clearSelection = clearSelection;
    window.updateContextTools = updateContextTools;
    window.initLayerSectionSorting = initLayerSectionSorting;
    window.saveLayerSectionOrder = saveLayerSectionOrder;
    window.restoreLayerSectionOrder = restoreLayerSectionOrder;
    window.toggleLayerGroup = toggleLayerGroup;
    window.toggleGroupVisibility = toggleGroupVisibility;
    window.toggleBatchVisibility = toggleBatchVisibility;
    
    // Auto-initialize on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', function() {
        // Check if we should auto-init (look for canvas element)
        if (document.getElementById('canvas')) {
            initEditor();
        }
    });
    
    console.log('DocuWeaver main module loaded');
})();
