/**
 * Text Editor - Text detection viewing and editing
 * Supports inline editing: resize bbox by dragging handles, edit text by clicking.
 */
const TextEditor = {
    detections: [],
    selectedIndices: new Set(),
    selectionOrder: [],
    fabricObjects: [],
    undoMgr: new UndoManager(),
    showLabels: true,
    drawMode: false,
    drawStart: null,
    drawRect: null,

    // Inline edit state
    editingIdx: null,         // Index of detection currently being edited inline
    editRect: null,           // Fabric rect for the editing box (resizable)
    editInput: null,          // HTML input element overlaid on canvas

    async load() {
        try {
            const data = await API.get(API.sessionUrl('/text'));
            this.detections = data.detections || [];
            this.selectedIndices.clear();
            this.selectionOrder = [];
            this.undoMgr.clear();
            this._exitEditMode(false);

            // Ensure coord scale is computed (text coords are in resized space)
            if (App.coordScale === 1.0) {
                await App._computeCoordScale();
            }

            this.render();
            this.updateSidebar();
        } catch (e) {
            App.setStatus('No text detection data available');
        }
    },

    /** Reload data from server without clearing undo history */
    async _reload() {
        try {
            const data = await API.get(API.sessionUrl('/text'));
            this.detections = data.detections || [];
            this.selectedIndices.clear();
            this.selectionOrder = [];
            this._exitEditMode(false);

            if (App.coordScale === 1.0) {
                await App._computeCoordScale();
            }

            this.render();
            this.updateSidebar();
        } catch (e) {
            App.setStatus('Error reloading text');
        }
    },

    /** Scale a bbox from text/line resized coords to image coords */
    _scaleToImage(bbox) {
        const s = App.coordScale;
        return [bbox[0] * s, bbox[1] * s, bbox[2] * s, bbox[3] * s];
    },

    /** Scale a bbox from image coords back to text/line resized coords */
    _scaleFromImage(bbox) {
        const s = App.coordScale;
        if (s === 0) return bbox;
        return [bbox[0] / s, bbox[1] / s, bbox[2] / s, bbox[3] / s];
    },

    render() {
        ImageViewer.clearOverlays();
        this.fabricObjects = [];

        for (let i = 0; i < this.detections.length; i++) {
            // Skip the one being edited inline (it has its own interactive rect)
            if (i === this.editingIdx) continue;

            const det = this.detections[i];
            const [x1, y1, x2, y2] = this._scaleToImage(det.bbox);
            const isSelected = this.selectedIndices.has(i);

            const rect = new fabric.Rect({
                left: x1, top: y1, width: x2 - x1, height: y2 - y1,
                fill: isSelected ? 'rgba(255,0,0,0.1)' : 'rgba(0,200,0,0.05)',
                stroke: isSelected ? '#ff0000' : '#00c853',
                strokeWidth: isSelected ? 2.5 : 1.5,
                selectable: false, evented: false,
            });
            ImageViewer.addObject(rect);

            if (this.showLabels && det.text) {
                const fontSize = Math.max(10, Math.min(14, (x2 - x1) / det.text.length * 1.5));
                const label = new fabric.Text(det.text, {
                    left: x1, top: Math.max(0, y1 - fontSize - 4),
                    fontSize: fontSize,
                    fill: isSelected ? '#ff4444' : '#ffffff',
                    fontFamily: 'monospace',
                    backgroundColor: isSelected ? 'rgba(255,255,0,0.7)' : 'rgba(0,0,0,0.5)',
                    selectable: false, evented: false,
                    padding: 2,
                });
                ImageViewer.addObject(label);
            }

            this.fabricObjects.push(rect);
        }
        ImageViewer.render();
    },

    onClick(pointer) {
        // If in edit mode, clicking outside the edit box commits the edit
        if (this.editingIdx !== null) {
            const det = this.detections[this.editingIdx];
            const [x1, y1, x2, y2] = this._scaleToImage(det.bbox);
            if (pointer.x < x1 || pointer.x > x2 || pointer.y < y1 || pointer.y > y2) {
                this._commitEdit();
            }
            return;
        }

        const x = pointer.x, y = pointer.y;
        let clickedIdx = null;

        // Find from end (top-most) to start; compare in image coords
        for (let i = this.detections.length - 1; i >= 0; i--) {
            const [x1, y1, x2, y2] = this._scaleToImage(this.detections[i].bbox);
            if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
                clickedIdx = i;
                break;
            }
        }

        if (clickedIdx !== null) {
            if (this.selectedIndices.has(clickedIdx)) {
                this.selectedIndices.delete(clickedIdx);
                this.selectionOrder = this.selectionOrder.filter(i => i !== clickedIdx);
            } else {
                if (!App.shiftKey) {
                    this.selectedIndices.clear();
                    this.selectionOrder = [];
                }
                this.selectedIndices.add(clickedIdx);
                this.selectionOrder.push(clickedIdx);
            }
        } else if (!App.shiftKey) {
            this.selectedIndices.clear();
            this.selectionOrder = [];
        }

        this.render();
        this.updateSidebar();
    },

    updateSidebar() {
        document.getElementById('sidebarTitle').textContent = 'Text Detections';
        document.getElementById('sidebarCount').textContent =
            `${this.detections.length} texts | ${this.selectedIndices.size} selected`;

        const filter = (document.getElementById('textFilter') || {}).value || '';
        const filterLower = filter.toLowerCase();

        let html = `<input class="filter-input" id="textFilter" placeholder="Filter text..."
                     value="${filter}" oninput="TextEditor.updateSidebar()">`;

        for (let i = 0; i < this.detections.length; i++) {
            const det = this.detections[i];
            const text = det.text || '';
            if (filterLower && !text.toLowerCase().includes(filterLower)) continue;

            const sel = this.selectedIndices.has(i) ? 'selected' : '';
            const editing = i === this.editingIdx ? 'style="border-left:3px solid #ffca28;"' : '';
            html += `<div class="list-item ${sel}" ${editing} onclick="TextEditor.toggleSelect(${i})"
                     ondblclick="TextEditor.enterEditMode(${i})">
                <span class="label">#${i} ${text}</span>
                <span class="score">${(det.score || 0).toFixed(2)}</span>
            </div>`;
        }

        if (this.editingIdx !== null) {
            const det = this.detections[this.editingIdx];
            html += `<div class="details-panel" style="border-top:2px solid #ffca28;">
                <div style="font-size:12px;color:#ffca28;margin-bottom:6px;font-weight:600">Editing #${this.editingIdx}</div>
                <div class="detail-row"><span class="detail-label">Text:</span><span>${det.text}</span></div>
                <div class="detail-row"><span class="detail-label">BBox:</span><span>${det.bbox.map(v => Math.round(v)).join(', ')}</span></div>
                <div style="margin-top:8px;font-size:11px;color:#888">Drag handles to resize. Click text to edit. Press Esc or Enter to finish.</div>
            </div>`;
        } else if (this.selectedIndices.size === 1) {
            const idx = [...this.selectedIndices][0];
            const det = this.detections[idx];
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Index:</span><span>#${idx}</span></div>
                <div class="detail-row"><span class="detail-label">Text:</span><span>${det.text}</span></div>
                <div class="detail-row"><span class="detail-label">Score:</span><span>${(det.score || 0).toFixed(4)}</span></div>
                <div class="detail-row"><span class="detail-label">BBox:</span><span>${det.bbox.join(', ')}</span></div>
                <div style="margin-top:6px;font-size:11px;color:#888">Double-click or press E to edit</div>
            </div>`;
        } else if (this.selectedIndices.size > 1) {
            const combined = this.selectionOrder.map(i => this.detections[i].text || '').join(' ');
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Selected:</span><span>${this.selectedIndices.size} texts</span></div>
                <div class="detail-row"><span class="detail-label">Combined:</span><span>${combined}</span></div>
            </div>`;
        }

        document.getElementById('sidebarContent').innerHTML = html;
    },

    toggleSelect(i) {
        if (this.editingIdx !== null) return; // Don't change selection during edit

        if (this.selectedIndices.has(i)) {
            this.selectedIndices.delete(i);
            this.selectionOrder = this.selectionOrder.filter(idx => idx !== i);
        } else {
            if (!App.shiftKey) {
                this.selectedIndices.clear();
                this.selectionOrder = [];
            }
            this.selectedIndices.add(i);
            this.selectionOrder.push(i);
        }
        this.render();
        this.updateSidebar();
    },

    clearSelection() {
        if (this.editingIdx !== null) {
            this._exitEditMode(false);
        }
        this.selectedIndices.clear();
        this.selectionOrder = [];
        this.render();
        this.updateSidebar();
    },

    // ---- Inline Edit Mode ----

    enterEditMode(idx, skipSnapshot) {
        if (idx === undefined) {
            if (this.selectedIndices.size !== 1) {
                App.showToast('Select exactly one text box to edit', 'error');
                return;
            }
            idx = [...this.selectedIndices][0];
        }

        // Exit previous edit if any
        if (this.editingIdx !== null) {
            this._commitEdit();
        }

        this.editingIdx = idx;
        if (!skipSnapshot) {
            this.undoMgr.snapshot(this.detections);
        }

        // Select this item
        this.selectedIndices.clear();
        this.selectedIndices.add(idx);
        this.selectionOrder = [idx];

        // Render all except the editing one
        this.render();

        // Create interactive fabric rect for the editing box
        const det = this.detections[idx];
        const [x1, y1, x2, y2] = this._scaleToImage(det.bbox);

        this.editRect = new fabric.Rect({
            left: x1,
            top: y1,
            width: x2 - x1,
            height: y2 - y1,
            fill: 'rgba(255,202,40,0.08)',
            stroke: '#ffca28',
            strokeWidth: 2.5,
            strokeDashArray: [6, 3],
            selectable: true,
            evented: true,
            hasControls: true,
            hasBorders: true,
            cornerColor: '#ffca28',
            cornerSize: 10,
            cornerStyle: 'circle',
            borderColor: '#ffca28',
            borderScaleFactor: 2,
            transparentCorners: false,
            lockRotation: true,
            // Prevent rotation handle
            _controlsVisibility: { mtr: false },
        });
        // Hide rotation control
        this.editRect.setControlsVisibility({ mtr: false });

        ImageViewer.addObject(this.editRect);
        ImageViewer.canvas.setActiveObject(this.editRect);
        ImageViewer.render();

        // Listen to rect modifications (resize/move)
        this.editRect.on('modified', () => this._onEditRectModified());
        this.editRect.on('scaling', () => ImageViewer.render());
        this.editRect.on('moving', () => ImageViewer.render());

        // Show inline text input
        this._showTextInput();
        this.updateSidebar();
        App.setStatus('Edit mode: drag handles to resize, click text to edit, Esc/Enter to finish');
    },

    _onEditRectModified() {
        if (this.editingIdx === null || !this.editRect) return;

        // Get the new bounding box from the fabric rect (accounting for scaling)
        const rect = this.editRect;
        const left = rect.left;
        const top = rect.top;
        const width = rect.width * rect.scaleX;
        const height = rect.height * rect.scaleY;

        // Reset scale to 1 and set actual width/height
        rect.set({
            width: width,
            height: height,
            scaleX: 1,
            scaleY: 1,
        });
        rect.setCoords();

        // Update the text input position
        this._repositionTextInput();
        ImageViewer.render();
    },

    _showTextInput() {
        this._removeTextInput();

        const det = this.detections[this.editingIdx];
        const container = document.getElementById('canvasContainer');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'text-edit-inline-input';
        input.value = det.text || '';
        input.placeholder = 'Enter text...';

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                this._commitEdit();
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this._exitEditMode(true); // revert
            }
            e.stopPropagation(); // Don't trigger app-level keyboard shortcuts
        });

        input.addEventListener('input', () => {
            // Live-update the detection text (will be committed on exit)
            this.detections[this.editingIdx].text = input.value;
            // Grow width to fit text
            this._repositionTextInput();
        });

        container.appendChild(input);
        this.editInput = input;
        this._repositionTextInput();

        // Focus after a short delay (let fabric events settle)
        setTimeout(() => input.focus(), 50);
    },

    _repositionTextInput() {
        if (!this.editInput || !this.editRect) return;

        const canvas = ImageViewer.canvas;
        const rect = this.editRect;
        const container = document.getElementById('canvasContainer');
        const containerRect = container.getBoundingClientRect();

        // Get the rect's position in screen (viewport) coordinates
        const zoom = canvas.getZoom();
        const vpt = canvas.viewportTransform;

        const left = rect.left;
        const top = rect.top;
        const width = rect.width * (rect.scaleX || 1);
        const height = rect.height * (rect.scaleY || 1);

        // Transform to screen coords
        const screenLeft = left * zoom + vpt[4];
        const screenTop = top * zoom + vpt[5];
        const screenWidth = width * zoom;
        const screenHeight = height * zoom;

        // Input sizing: ensure text is readable regardless of box size
        const fontSize = 14;
        const inputHeight = fontSize + 12; // padding
        // Width: at least as wide as the box, but also wide enough to show the text
        const textLen = (this.editInput.value || '').length;
        const estTextWidth = textLen * fontSize * 0.65 + 24; // rough char width + padding
        const inputWidth = Math.max(200, screenWidth, estTextWidth);

        // Position below the box, aligned to left edge
        const inputLeft = Math.max(0, Math.min(screenLeft, containerRect.width - inputWidth - 4));
        let inputTop = screenTop + screenHeight + 4;
        // If below would go off-screen, put above
        if (inputTop + inputHeight > containerRect.height) {
            inputTop = screenTop - inputHeight - 4;
        }

        this.editInput.style.left = Math.round(inputLeft) + 'px';
        this.editInput.style.top = Math.round(inputTop) + 'px';
        this.editInput.style.width = Math.round(inputWidth) + 'px';
        this.editInput.style.height = Math.round(inputHeight) + 'px';
        this.editInput.style.fontSize = fontSize + 'px';
    },

    _removeTextInput() {
        if (this.editInput) {
            this.editInput.remove();
            this.editInput = null;
        }
    },

    _commitEdit() {
        if (this.editingIdx === null) return;

        const idx = this.editingIdx;
        const det = this.detections[idx];

        // Get final text from input
        if (this.editInput) {
            det.text = this.editInput.value;
        }

        // Get final bbox from the fabric rect
        if (this.editRect) {
            const rect = this.editRect;
            const left = rect.left;
            const top = rect.top;
            const width = rect.width * (rect.scaleX || 1);
            const height = rect.height * (rect.scaleY || 1);

            const bboxImage = [left, top, left + width, top + height];
            det.bbox = this._scaleFromImage(bboxImage).map(v => Math.round(v));
        }

        // Save to server
        API.put(API.sessionUrl(`/text/${idx}`), { text: det.text, bbox: det.bbox });

        this._cleanupEditMode();
        this.render();
        this.updateSidebar();
        App.setStatus(`Updated text #${idx}`);
    },

    _exitEditMode(revert) {
        if (this.editingIdx === null) return;

        if (revert) {
            // Restore from undo snapshot
            const prev = this.undoMgr.undo(this.detections);
            if (prev) {
                this.detections = prev;
                API.put(API.sessionUrl('/text/bulk'), { detections: this.detections });
            }
        }

        this._cleanupEditMode();
        this.render();
        this.updateSidebar();
        App.setStatus('Edit cancelled');
    },

    _cleanupEditMode() {
        if (this.editRect) {
            ImageViewer.canvas.discardActiveObject();
            ImageViewer.removeObject(this.editRect);
            this.editRect = null;
        }
        this._removeTextInput();
        this.editingIdx = null;
    },

    // ---- Legacy edit dialog (fallback) ----

    editTextDialog(idx) {
        // Now routes to inline edit mode
        this.enterEditMode(idx);
    },

    async deleteSelected() {
        if (this.selectedIndices.size === 0) return;
        if (this.editingIdx !== null) this._commitEdit();
        if (!confirm(`Delete ${this.selectedIndices.size} text box(es)?`)) return;

        this.undoMgr.snapshot(this.detections);

        // Delete from end to preserve indices
        const sorted = [...this.selectedIndices].sort((a, b) => b - a);
        for (const idx of sorted) {
            this.detections.splice(idx, 1);
        }

        // Bulk update server
        await API.put(API.sessionUrl('/text/bulk'), { detections: this.detections });

        this.selectedIndices.clear();
        this.selectionOrder = [];
        this.render();
        this.updateSidebar();
        App.setStatus('Deleted text boxes');
    },

    async combineSelected() {
        if (this.selectionOrder.length < 2) {
            App.showToast('Select at least 2 text boxes to combine', 'error');
            return;
        }
        if (this.editingIdx !== null) this._commitEdit();

        this.undoMgr.snapshot(this.detections);

        const result = await API.post(API.sessionUrl('/text/combine'), {
            indices: this.selectionOrder
        });

        this.selectedIndices.clear();
        this.selectionOrder = [];
        await this._reload();
        App.setStatus('Combined text boxes');
    },

    toggleLabels() {
        this.showLabels = !this.showLabels;
        this.render();
    },

    // ---- Draw mode ----

    toggleDraw() {
        if (this.editingIdx !== null) this._commitEdit();
        this.drawMode = !this.drawMode;
        const btn = document.getElementById('btnDrawText');
        if (btn) btn.classList.toggle('active', this.drawMode);
        App.setStatus(this.drawMode ? 'Draw mode: click and drag to create a text box' : 'Draw mode off');
    },

    onMouseDown(pointer) {
        if (!this.drawMode) return false;
        this.drawStart = { x: pointer.x, y: pointer.y };
        this.drawRect = new fabric.Rect({
            left: pointer.x, top: pointer.y, width: 0, height: 0,
            fill: 'rgba(0,200,0,0.15)', stroke: '#00c853', strokeWidth: 2,
            strokeDashArray: [6, 3],
            selectable: false, evented: false,
        });
        ImageViewer.addObject(this.drawRect);
        return true;
    },

    onMouseMove(pointer) {
        if (!this.drawMode || !this.drawStart || !this.drawRect) return;
        const x = Math.min(this.drawStart.x, pointer.x);
        const y = Math.min(this.drawStart.y, pointer.y);
        const w = Math.abs(pointer.x - this.drawStart.x);
        const h = Math.abs(pointer.y - this.drawStart.y);
        this.drawRect.set({ left: x, top: y, width: w, height: h });
        ImageViewer.render();
    },

    async onMouseUp(pointer) {
        if (!this.drawMode || !this.drawStart) return;
        const x1 = Math.round(Math.min(this.drawStart.x, pointer.x));
        const y1 = Math.round(Math.min(this.drawStart.y, pointer.y));
        const x2 = Math.round(Math.max(this.drawStart.x, pointer.x));
        const y2 = Math.round(Math.max(this.drawStart.y, pointer.y));

        if (this.drawRect) ImageViewer.removeObject(this.drawRect);
        this.drawStart = null;
        this.drawRect = null;

        if (x2 - x1 < 5 || y2 - y1 < 5) return;

        // Convert from image coords to text/line resized coords
        const bboxResized = this._scaleFromImage([x1, y1, x2, y2]).map(v => Math.round(v));

        this.undoMgr.snapshot(this.detections);
        const result = await API.post(API.sessionUrl('/text'), { bbox: bboxResized, text: '' });
        await this._reload();

        // Enter edit mode on the newly created text box (skip snapshot — already taken above)
        const newIdx = this.detections.length - 1;
        this.enterEditMode(newIdx, true);
        App.setStatus('Created new text box — enter text');
    },

    async undo() {
        if (this.editingIdx !== null) this._exitEditMode(true);
        const prev = this.undoMgr.undo(this.detections);
        if (!prev) { App.setStatus('Nothing to undo'); return; }
        this.detections = prev;
        await API.put(API.sessionUrl('/text/bulk'), { detections: this.detections });
        this.selectedIndices.clear();
        this.selectionOrder = [];
        this.render();
        this.updateSidebar();
        App.setStatus('Undo');
    },

    async redo() {
        if (this.editingIdx !== null) this._commitEdit();
        const next = this.undoMgr.redo(this.detections);
        if (!next) { App.setStatus('Nothing to redo'); return; }
        this.detections = next;
        await API.put(API.sessionUrl('/text/bulk'), { detections: this.detections });
        this.selectedIndices.clear();
        this.selectionOrder = [];
        this.render();
        this.updateSidebar();
        App.setStatus('Redo');
    },

    getToolbar() {
        return `
            <button class="btn" onclick="TextEditor.clearSelection()">Clear Selection</button>
            <button class="btn" onclick="TextEditor.enterEditMode()">Edit (E)</button>
            <button class="btn" onclick="TextEditor.combineSelected()">Combine (C)</button>
            <button class="btn danger" onclick="TextEditor.deleteSelected()">Delete</button>
            <div class="btn-sep"></div>
            <button class="btn" id="btnDrawText" onclick="TextEditor.toggleDraw()">Draw New Text</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="TextEditor.undo()">Undo</button>
            <button class="btn" onclick="TextEditor.redo()">Redo</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="TextEditor.toggleLabels()">Toggle Labels</button>
            <button class="btn" onclick="ImageViewer.fitToScreen()">Fit View</button>
        `;
    },

    deactivate() {
        if (this.editingIdx !== null) this._commitEdit();
        this.drawMode = false;
    },
};
