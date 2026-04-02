/**
 * DocuWeaver Canvas Editor - Join Marks Module
 *
 * Handles join mark detection, display, linking, and sheet alignment.
 *
 * Depends on: namespace.js, sheets.js
 */

(function() {
    'use strict';

    const DW = window.DocuWeaver;
    const state = DW.state;

    // Module state
    let joinMarkOverlays = [];    // Fabric objects on canvas
    let linkingMode = false;      // Whether we're in mark-linking mode
    let linkSourceMark = null;    // First mark selected for linking

    // ==================== Detection ====================

    async function detectJoinMarks(sheetId) {
        if (!sheetId) {
            DW.showToast('Select a sheet first', 'error');
            return;
        }

        var btn = document.getElementById('detect-join-marks-btn');
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Detecting...';
        }

        try {
            var response = await fetch('/api/sheets/' + sheetId + '/detect-join-marks/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ clear_existing: true })
            });

            if (response.ok) {
                var result = await response.json();
                DW.showToast('Detected ' + result.detected + ' join mark(s)', 'success');
                await refreshJoinMarks(sheetId);
                renderJoinMarksList(sheetId);
            } else {
                DW.showToast('Detection failed', 'error');
            }
        } catch (error) {
            console.error('Join mark detection error:', error);
            DW.showToast('Detection error', 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Detect Join Marks';
            }
        }
    }

    // ==================== Data Loading ====================

    async function refreshJoinMarks(sheetId) {
        try {
            var response = await fetch('/api/sheets/' + sheetId + '/join-marks/');
            if (response.ok) {
                var marks = await response.json();
                // Store on the sheet data
                var sheet = state.sheets.find(function(s) { return s.id === sheetId; });
                if (sheet) {
                    sheet._joinMarks = marks;
                }
                renderJoinMarkOverlays(sheetId, marks);
                return marks;
            }
        } catch (error) {
            console.error('Error loading join marks:', error);
        }
        return [];
    }

    // ==================== Canvas Overlays ====================

    function renderJoinMarkOverlays(sheetId, marks) {
        clearJoinMarkOverlays();

        var canvas = state.canvas;

        // Find the sheet object on canvas to get its position
        var sheetObj = canvas.getObjects().find(function(obj) {
            return obj.sheetData && obj.sheetData.id === sheetId;
        });

        if (!sheetObj || !marks || marks.length === 0) return;

        marks.forEach(function(mark) {
            var absX = sheetObj.left + mark.x;
            var absY = sheetObj.top + mark.y;

            // Draw marker circle
            var circle = new fabric.Circle({
                left: absX - 8,
                top: absY - 8,
                radius: 8,
                fill: mark.linked_mark ? 'rgba(40, 167, 69, 0.6)' : 'rgba(255, 193, 7, 0.7)',
                stroke: mark.linked_mark ? '#28a745' : '#ffc107',
                strokeWidth: 2,
                selectable: false,
                evented: true,
                hoverCursor: 'pointer',
            });
            circle._joinMarkData = mark;
            circle._joinMarkSheetId = sheetId;

            // Click handler for linking
            circle.on('mousedown', function() {
                handleMarkClick(mark, sheetId);
            });

            // Label
            var label = new fabric.Text(
                mark.reference_label || mark.shape,
                {
                    left: absX + 12,
                    top: absY - 6,
                    fontSize: 11,
                    fill: '#ffffff',
                    backgroundColor: 'rgba(0,0,0,0.6)',
                    selectable: false,
                    evented: false,
                }
            );

            canvas.add(circle);
            canvas.add(label);
            joinMarkOverlays.push(circle, label);
        });

        canvas.renderAll();
    }

    function clearJoinMarkOverlays() {
        var canvas = state.canvas;
        joinMarkOverlays.forEach(function(obj) {
            canvas.remove(obj);
        });
        joinMarkOverlays = [];
    }

    // ==================== Join Mark List UI ====================

    function renderJoinMarksList(sheetId) {
        var container = document.getElementById('join-marks-list');
        if (!container) return;

        var sheet = state.sheets.find(function(s) { return s.id === sheetId; });
        var marks = (sheet && sheet._joinMarks) || [];

        container.innerHTML = '';

        if (marks.length === 0) {
            container.innerHTML = '<div class="text-muted" style="font-size:0.85rem;padding:0.25rem 0;">No join marks detected</div>';
            return;
        }

        marks.forEach(function(mark) {
            var div = document.createElement('div');
            div.style.cssText = 'display:flex;align-items:center;gap:0.4rem;padding:0.3rem 0;border-bottom:1px solid var(--border-color,#333);font-size:0.85rem;';

            // Status dot
            var dot = document.createElement('span');
            dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex-shrink:0;';
            dot.style.background = mark.linked_mark ? '#28a745' : '#ffc107';
            dot.title = mark.linked_mark ? 'Linked' : 'Unlinked';

            // Shape icon + label
            var shapeIcons = { triangle: '\u25B2', diamond: '\u25C6', circle: '\u25CF', arrow: '\u25BA', manual: '\u2316' };
            var info = document.createElement('span');
            info.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            info.textContent = (shapeIcons[mark.shape] || '') + ' ' + (mark.reference_label || mark.edge);
            info.title = 'Confidence: ' + (mark.confidence * 100).toFixed(0) + '%';

            div.appendChild(dot);
            div.appendChild(info);

            // Link button
            if (!mark.linked_mark) {
                var linkBtn = document.createElement('button');
                linkBtn.textContent = 'Link';
                linkBtn.className = 'btn';
                linkBtn.style.cssText = 'font-size:0.7rem;padding:0.1rem 0.4rem;';
                linkBtn.onclick = function() { startLinking(mark, sheetId); };
                div.appendChild(linkBtn);
            } else {
                var alignBtn = document.createElement('button');
                alignBtn.textContent = 'Align';
                alignBtn.className = 'btn btn-success';
                alignBtn.style.cssText = 'font-size:0.7rem;padding:0.1rem 0.4rem;';
                alignBtn.onclick = function() { alignByMark(mark); };
                div.appendChild(alignBtn);

                var unlinkBtn = document.createElement('button');
                unlinkBtn.textContent = '\u2715';
                unlinkBtn.className = 'btn';
                unlinkBtn.style.cssText = 'font-size:0.7rem;padding:0.1rem 0.3rem;';
                unlinkBtn.title = 'Unlink';
                unlinkBtn.onclick = function() { unlinkMark(mark.id, sheetId); };
                div.appendChild(unlinkBtn);
            }

            // Delete button
            var delBtn = document.createElement('button');
            delBtn.textContent = '\uD83D\uDDD1';
            delBtn.className = 'btn';
            delBtn.style.cssText = 'font-size:0.7rem;padding:0.1rem 0.3rem;';
            delBtn.title = 'Delete mark';
            delBtn.onclick = function() { deleteMark(mark.id, sheetId); };
            div.appendChild(delBtn);

            container.appendChild(div);
        });
    }

    // ==================== Linking Workflow ====================

    function startLinking(mark, sheetId) {
        linkingMode = true;
        linkSourceMark = { mark: mark, sheetId: sheetId };
        DW.showToast('Click a join mark on another sheet to link', 'info');

        // Show marks on all other sheets
        showAllSheetMarks(sheetId);
    }

    async function showAllSheetMarks(excludeSheetId) {
        // Load and display marks for all other sheets
        for (var i = 0; i < state.sheets.length; i++) {
            var sheet = state.sheets[i];
            if (sheet.id === excludeSheetId) continue;

            var marks = await refreshJoinMarks(sheet.id);
            if (marks && marks.length > 0) {
                renderJoinMarkOverlaysForSheet(sheet.id, marks);
            }
        }
    }

    function renderJoinMarkOverlaysForSheet(sheetId, marks) {
        var canvas = state.canvas;
        var sheetObj = canvas.getObjects().find(function(obj) {
            return obj.sheetData && obj.sheetData.id === sheetId;
        });
        if (!sheetObj || !marks) return;

        marks.forEach(function(mark) {
            var absX = sheetObj.left + mark.x;
            var absY = sheetObj.top + mark.y;

            var circle = new fabric.Circle({
                left: absX - 8,
                top: absY - 8,
                radius: 8,
                fill: mark.linked_mark ? 'rgba(40, 167, 69, 0.6)' : 'rgba(52, 152, 219, 0.7)',
                stroke: mark.linked_mark ? '#28a745' : '#3498db',
                strokeWidth: 2,
                selectable: false,
                evented: true,
                hoverCursor: 'pointer',
            });
            circle._joinMarkData = mark;
            circle._joinMarkSheetId = sheetId;

            circle.on('mousedown', function() {
                handleMarkClick(mark, sheetId);
            });

            canvas.add(circle);
            joinMarkOverlays.push(circle);
        });

        canvas.renderAll();
    }

    function handleMarkClick(mark, sheetId) {
        if (!linkingMode || !linkSourceMark) return;

        // Can't link to same sheet
        if (sheetId === linkSourceMark.sheetId) {
            DW.showToast('Select a mark on a different sheet', 'error');
            return;
        }

        // Link them
        performLink(linkSourceMark.mark.id, mark.id, linkSourceMark.sheetId);
    }

    async function performLink(markAId, markBId, sourceSheetId) {
        linkingMode = false;

        try {
            var response = await fetch('/api/join-marks/link/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ mark_a: markAId, mark_b: markBId })
            });

            if (response.ok) {
                DW.showToast('Marks linked successfully', 'success');
                linkSourceMark = null;
                clearJoinMarkOverlays();
                await refreshJoinMarks(sourceSheetId);
                renderJoinMarksList(sourceSheetId);
            } else {
                var err = await response.json();
                DW.showToast('Link failed: ' + (err.error || 'Unknown error'), 'error');
            }
        } catch (error) {
            console.error('Link error:', error);
            DW.showToast('Error linking marks', 'error');
        }
    }

    function cancelLinking() {
        linkingMode = false;
        linkSourceMark = null;
        clearJoinMarkOverlays();

        // Re-show marks for the selected sheet
        if (state.selectedSheet) {
            refreshJoinMarks(state.selectedSheet.id);
            renderJoinMarksList(state.selectedSheet.id);
        }
    }

    // ==================== Alignment ====================

    async function alignByMark(mark) {
        if (!mark.linked_mark) {
            DW.showToast('Mark is not linked', 'error');
            return;
        }

        try {
            var response = await fetch('/api/join-marks/align/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({
                    mark_a: mark.linked_mark,
                    mark_b: mark.id,
                    apply: true
                })
            });

            if (response.ok) {
                var result = await response.json();
                DW.showToast('Sheet aligned', 'success');

                // Update local state
                var sheet = state.sheets.find(function(s) { return s.id === result.sheet_id; });
                if (sheet) {
                    sheet.offset_x = result.new_offset_x;
                    sheet.offset_y = result.new_offset_y;
                }

                // Update canvas position
                if (typeof updateSheetOnCanvas === 'function') {
                    updateSheetOnCanvas(result.sheet_id, 'offset_x', result.new_offset_x);
                    updateSheetOnCanvas(result.sheet_id, 'offset_y', result.new_offset_y);
                }

                // Refresh overlays
                clearJoinMarkOverlays();
                if (state.selectedSheet) {
                    refreshJoinMarks(state.selectedSheet.id);
                }

                // Refresh properties panel
                if (state.selectedSheet && state.selectedSheet.id === result.sheet_id) {
                    document.getElementById('sheet-offset-x').value = result.new_offset_x;
                    document.getElementById('sheet-offset-y').value = result.new_offset_y;
                }
            } else {
                DW.showToast('Alignment failed', 'error');
            }
        } catch (error) {
            console.error('Alignment error:', error);
            DW.showToast('Alignment error', 'error');
        }
    }

    // ==================== CRUD Helpers ====================

    async function deleteMark(markId, sheetId) {
        try {
            var response = await fetch('/api/join-marks/' + markId + '/delete/', {
                method: 'DELETE',
                headers: { 'X-CSRFToken': DW.getCSRFToken() }
            });

            if (response.ok || response.status === 204) {
                await refreshJoinMarks(sheetId);
                renderJoinMarksList(sheetId);
                DW.showToast('Mark deleted', 'success');
            }
        } catch (error) {
            console.error('Delete mark error:', error);
        }
    }

    async function unlinkMark(markId, sheetId) {
        try {
            var response = await fetch('/api/join-marks/' + markId + '/unlink/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                }
            });

            if (response.ok) {
                await refreshJoinMarks(sheetId);
                renderJoinMarksList(sheetId);
                DW.showToast('Mark unlinked', 'success');
            }
        } catch (error) {
            console.error('Unlink error:', error);
        }
    }

    async function addManualMark(sheetId, x, y) {
        try {
            var response = await fetch('/api/sheets/' + sheetId + '/join-marks/create/', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': DW.getCSRFToken()
                },
                body: JSON.stringify({ x: x, y: y, reference_label: 'Manual mark' })
            });

            if (response.ok) {
                await refreshJoinMarks(sheetId);
                renderJoinMarksList(sheetId);
                DW.showToast('Mark added', 'success');
            }
        } catch (error) {
            console.error('Add mark error:', error);
        }
    }

    // ==================== Public API ====================

    DW.joinMarks = {
        detectJoinMarks: detectJoinMarks,
        refreshJoinMarks: refreshJoinMarks,
        renderJoinMarksList: renderJoinMarksList,
        clearJoinMarkOverlays: clearJoinMarkOverlays,
        startLinking: startLinking,
        cancelLinking: cancelLinking,
        alignByMark: alignByMark,
        addManualMark: addManualMark,
    };

    // Expose globally
    window.detectJoinMarks = detectJoinMarks;
    window.refreshJoinMarks = refreshJoinMarks;
    window.renderJoinMarksList = renderJoinMarksList;
    window.clearJoinMarkOverlays = clearJoinMarkOverlays;
    window.cancelLinking = cancelLinking;
    window.addManualMark = addManualMark;

    console.log('DocuWeaver join marks module loaded');
})();
