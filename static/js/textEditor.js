/**
 * Text Editor - Text detection viewing and editing
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

    async load() {
        try {
            const data = await API.get(API.sessionUrl('/text'));
            this.detections = data.detections || [];
            this.selectedIndices.clear();
            this.selectionOrder = [];
            this.undoMgr.clear();

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

    /** Scale a bbox from text/line resized coords to image coords */
    _scaleToImage(bbox) {
        const s = App.coordScale;
        return [bbox[0] * s, bbox[1] * s, bbox[2] * s, bbox[3] * s];
    },

    render() {
        ImageViewer.clearOverlays();
        this.fabricObjects = [];

        for (let i = 0; i < this.detections.length; i++) {
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
            html += `<div class="list-item ${sel}" onclick="TextEditor.toggleSelect(${i})"
                     ondblclick="TextEditor.editTextDialog(${i})">
                <span class="label">#${i} ${text}</span>
                <span class="score">${(det.score || 0).toFixed(2)}</span>
            </div>`;
        }

        if (this.selectedIndices.size === 1) {
            const idx = [...this.selectedIndices][0];
            const det = this.detections[idx];
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Index:</span><span>#${idx}</span></div>
                <div class="detail-row"><span class="detail-label">Text:</span><span>${det.text}</span></div>
                <div class="detail-row"><span class="detail-label">Score:</span><span>${(det.score || 0).toFixed(4)}</span></div>
                <div class="detail-row"><span class="detail-label">BBox:</span><span>${det.bbox.join(', ')}</span></div>
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
        this.selectedIndices.clear();
        this.selectionOrder = [];
        this.render();
        this.updateSidebar();
    },

    editTextDialog(idx) {
        if (idx === undefined) {
            if (this.selectedIndices.size !== 1) {
                App.showToast('Select exactly one text box to edit', 'error');
                return;
            }
            idx = [...this.selectedIndices][0];
        }

        const det = this.detections[idx];
        const newText = prompt('Edit text:', det.text);
        if (newText !== null && newText !== det.text) {
            this.undoMgr.snapshot(this.detections);
            this.detections[idx].text = newText;
            API.put(API.sessionUrl(`/text/${idx}`), { text: newText });
            this.render();
            this.updateSidebar();
            App.setStatus(`Updated text #${idx}`);
        }
    },

    async deleteSelected() {
        if (this.selectedIndices.size === 0) return;
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

        this.undoMgr.snapshot(this.detections);

        const result = await API.post(API.sessionUrl('/text/combine'), {
            indices: this.selectionOrder
        });

        this.selectedIndices.clear();
        this.selectionOrder = [];
        await this.load();
        App.setStatus('Combined text boxes');
    },

    toggleLabels() {
        this.showLabels = !this.showLabels;
        this.render();
    },

    // ---- Draw mode ----

    toggleDraw() {
        this.drawMode = !this.drawMode;
        const btn = document.getElementById('btnDrawText');
        if (btn) btn.classList.toggle('active', this.drawMode);
        App.setStatus(this.drawMode ? 'Draw mode: click and drag to create a text box' : 'Draw mode off');
    },

    /** Scale a bbox from image coords back to text/line resized coords */
    _scaleFromImage(bbox) {
        const s = App.coordScale;
        if (s === 0) return bbox;
        return [bbox[0] / s, bbox[1] / s, bbox[2] / s, bbox[3] / s];
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

        // Prompt for text content
        const text = prompt('Enter text for this box:');
        if (text === null) return;

        // Convert from image coords to text/line resized coords
        const bboxResized = this._scaleFromImage([x1, y1, x2, y2]).map(v => Math.round(v));

        this.undoMgr.snapshot(this.detections);
        await API.post(API.sessionUrl('/text'), { bbox: bboxResized, text });
        await this.load();
        App.setStatus('Created new text box');
    },

    async undo() {
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
            <button class="btn" onclick="TextEditor.editTextDialog()">Edit Text (E)</button>
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
        this.drawMode = false;
    },
};
