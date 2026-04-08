/**
 * Mask Editor - Symbol mask viewing and editing
 * Supports: select, delete, merge, draw new, and drag-resize editing.
 */
const MaskEditor = {
    masks: [],
    selectedIds: new Set(),
    fabricObjects: {},
    drawMode: false,
    drawStart: null,
    drawRect: null,
    // Edit mode: when active, the selected mask becomes a draggable/resizable Fabric rect
    editMode: false,
    editingId: null,
    editRect: null,

    async load() {
        try {
            const data = await API.get(API.sessionUrl('/masks'));
            this.masks = data.masks || [];
            this.selectedIds.clear();
            this.exitEditMode(false);
            this.render();
            this.updateSidebar();
        } catch (e) {
            App.setStatus('No symbol detection data available');
        }
    },

    render() {
        ImageViewer.clearOverlays();
        this.fabricObjects = {};

        const colors = [
            '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9',
        ];

        for (const mask of this.masks) {
            // Skip the mask being edited — it has its own interactive rect
            if (this.editMode && this.editingId === mask.id) continue;

            const [x1, y1, x2, y2] = mask.bbox;
            const isSelected = this.selectedIds.has(mask.id);

            const rect = new fabric.Rect({
                left: x1, top: y1,
                width: x2 - x1, height: y2 - y1,
                fill: isSelected ? 'rgba(255,0,0,0.15)' : `${colors[mask.id % colors.length]}22`,
                stroke: isSelected ? '#ff0000' : colors[mask.id % colors.length],
                strokeWidth: isSelected ? 3 : 1.5,
                selectable: false, evented: false,
            });
            ImageViewer.addObject(rect);
            this.fabricObjects[mask.id] = rect;
        }

        // If in edit mode, add the interactive rect on top
        if (this.editMode && this.editRect) {
            ImageViewer.addObject(this.editRect);
            ImageViewer.canvas.setActiveObject(this.editRect);
        }

        ImageViewer.render();
    },

    onClick(pointer) {
        // In edit mode, clicks are handled by Fabric.js on the interactive rect
        if (this.editMode) return;

        const x = pointer.x, y = pointer.y;
        let clickedId = null;

        let smallestArea = Infinity;
        for (const mask of this.masks) {
            const [x1, y1, x2, y2] = mask.bbox;
            if (x >= x1 && x <= x2 && y >= y1 && y <= y2) {
                const area = (x2 - x1) * (y2 - y1);
                if (area < smallestArea) {
                    smallestArea = area;
                    clickedId = mask.id;
                }
            }
        }

        if (clickedId !== null) {
            if (this.selectedIds.has(clickedId)) {
                this.selectedIds.delete(clickedId);
            } else {
                if (!App.shiftKey) this.selectedIds.clear();
                this.selectedIds.add(clickedId);
            }
        } else if (!App.shiftKey) {
            this.selectedIds.clear();
        }

        this.render();
        this.updateSidebar();
    },

    updateSidebar() {
        const sidebar = document.getElementById('sidebarContent');
        document.getElementById('sidebarTitle').textContent = 'Symbols';
        document.getElementById('sidebarCount').textContent = `${this.masks.length} masks | ${this.selectedIds.size} selected`;

        let html = '';
        for (const mask of this.masks) {
            const sel = this.selectedIds.has(mask.id) ? 'selected' : '';
            html += `<div class="list-item ${sel}" onclick="MaskEditor.toggleSelect(${mask.id})">
                <span class="label">#${mask.id} [${mask.bbox.join(', ')}]</span>
                <span class="score">${mask.score.toFixed(2)}</span>
            </div>`;
        }

        if (this.editMode && this.editingId !== null) {
            html += `<div class="details-panel" style="border-top:2px solid #4fc3f7">
                <div style="color:#4fc3f7;font-weight:600;margin-bottom:6px">Editing Mask #${this.editingId}</div>
                <div style="font-size:12px;color:#aaa;margin-bottom:8px">
                    Drag to move, drag corners/edges to resize.<br>
                    Click "Done Editing" when finished.
                </div>
                <button class="btn primary" style="width:100%" onclick="MaskEditor.finishEdit()">Done Editing</button>
                <button class="btn" style="width:100%;margin-top:4px" onclick="MaskEditor.cancelEdit()">Cancel</button>
            </div>`;
        } else if (this.selectedIds.size === 1) {
            const id = [...this.selectedIds][0];
            const mask = this.masks.find(m => m.id === id);
            if (mask) {
                const [x1, y1, x2, y2] = mask.bbox;
                html += `<div class="details-panel">
                    <div class="detail-row"><span class="detail-label">ID:</span><span>#${mask.id}</span></div>
                    <div class="detail-row"><span class="detail-label">BBox:</span><span>[${mask.bbox.join(', ')}]</span></div>
                    <div class="detail-row"><span class="detail-label">Size:</span><span>${x2-x1} x ${y2-y1}</span></div>
                    <div class="detail-row"><span class="detail-label">Area:</span><span>${mask.area}</span></div>
                    <div class="detail-row"><span class="detail-label">Score:</span><span>${mask.score.toFixed(4)}</span></div>
                    <div class="detail-row"><span class="detail-label">Center:</span><span>[${mask.center.join(', ')}]</span></div>
                    <div style="margin-top:8px;text-align:center">
                        <img src="${API.sessionUrl(`/masks/${mask.id}/patch`)}" style="max-width:120px;max-height:120px;border:1px solid #3a3a5c;border-radius:4px;background:#000">
                    </div>
                </div>`;
            }
        } else if (this.selectedIds.size > 1) {
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Selected:</span><span>${this.selectedIds.size} mask(s)</span></div>
                <div style="margin-top:8px;font-size:12px;color:#888">
                    Use "Merge Selected" to combine, or "Delete Selected" to remove.
                </div>
            </div>`;
        }

        sidebar.innerHTML = html;
    },

    toggleSelect(id) {
        if (this.editMode) return; // don't change selection during edit
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id);
        } else {
            if (!App.shiftKey) this.selectedIds.clear();
            this.selectedIds.add(id);
        }
        this.render();
        this.updateSidebar();
    },

    getToolbar() {
        if (this.editMode) {
            return `
                <span style="color:#4fc3f7;font-size:14px;padding:6px 12px;font-weight:600">Editing Mask #${this.editingId}</span>
                <span style="color:#888;font-size:13px;padding:6px">Drag to move, drag handles to resize</span>
                <div class="btn-sep"></div>
                <button class="btn primary" onclick="MaskEditor.finishEdit()">Done Editing</button>
                <button class="btn" onclick="MaskEditor.cancelEdit()">Cancel</button>
            `;
        }
        return `
            <button class="btn" onclick="MaskEditor.clearSelection()">Clear Selection</button>
            <button class="btn" onclick="MaskEditor.editSelected()">Edit Selected</button>
            <button class="btn danger" onclick="MaskEditor.deleteSelected()">Delete Selected</button>
            <button class="btn" onclick="MaskEditor.mergeSelected()">Merge Selected</button>
            <div class="btn-sep"></div>
            <button class="btn" id="btnDrawMask" onclick="MaskEditor.toggleDraw()">Draw New Mask</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="MaskEditor.fitView()">Fit View</button>
        `;
    },

    // ---- Edit Mode: drag-resize ----

    editSelected() {
        if (this.selectedIds.size !== 1) {
            App.showToast('Select exactly one mask to edit', 'error');
            return;
        }
        const id = [...this.selectedIds][0];
        const mask = this.masks.find(m => m.id === id);
        if (!mask) return;


        this.editMode = true;
        this.editingId = id;

        const [x1, y1, x2, y2] = mask.bbox;

        // Create a Fabric rect that is selectable, movable, resizable
        this.editRect = new fabric.Rect({
            left: x1, top: y1,
            width: x2 - x1, height: y2 - y1,
            fill: 'rgba(79,195,247,0.15)',
            stroke: '#4fc3f7',
            strokeWidth: 2.5,
            strokeDashArray: [6, 3],
            cornerColor: '#4fc3f7',
            cornerStrokeColor: '#fff',
            cornerSize: 10,
            transparentCorners: false,
            cornerStyle: 'circle',
            borderColor: '#4fc3f7',
            borderDashArray: [4, 4],
            hasRotatingPoint: false,
            lockRotation: true,
            // Allow move and resize
            selectable: true,
            evented: true,
        });

        // Update toolbar and sidebar to show edit controls
        document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        this.render();
        this.updateSidebar();

        App.setStatus(`Editing mask #${id} — drag to move, drag corners to resize`);
    },

    async finishEdit() {
        if (!this.editMode || !this.editRect) return;

        // Read the final position/size from the Fabric rect
        // Fabric.js uses scaleX/scaleY when resizing via handles
        const rect = this.editRect;
        const x1 = Math.round(rect.left);
        const y1 = Math.round(rect.top);
        const x2 = Math.round(rect.left + rect.width * (rect.scaleX || 1));
        const y2 = Math.round(rect.top + rect.height * (rect.scaleY || 1));

        const id = this.editingId;

        // Save to server
        await API.put(API.sessionUrl(`/masks/${id}`), { bbox: [x1, y1, x2, y2] });

        // Update local data
        const mask = this.masks.find(m => m.id === id);
        if (mask) {
            mask.bbox = [x1, y1, x2, y2];
            mask.center = [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
            mask.area = (x2 - x1) * (y2 - y1);
        }

        this.exitEditMode(true);
        // Keep the edited mask selected
        this.selectedIds.clear();
        this.selectedIds.add(id);
        this.render();
        this.updateSidebar();
        document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        App.setStatus(`Mask #${id} updated`);
    },

    cancelEdit() {
        this.exitEditMode(true);
        App.setStatus('Edit cancelled');
    },

    exitEditMode(rerender) {
        if (this.editRect) {
            ImageViewer.canvas.discardActiveObject();
            ImageViewer.removeObject(this.editRect);
            this.editRect = null;
        }
        this.editMode = false;
        this.editingId = null;
        if (rerender) {
            this.render();
            this.updateSidebar();
            document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        }
    },

    // ---- Other actions ----

    clearSelection() {
        if (this.editMode) this.exitEditMode(false);
        this.selectedIds.clear();
        this.render();
        this.updateSidebar();
    },

    async deleteSelected() {
        if (this.selectedIds.size === 0) return;
        if (this.editMode) this.exitEditMode(false);


        for (const id of this.selectedIds) {
            await API.del(API.sessionUrl(`/masks/${id}`));
        }

        this.selectedIds.clear();
        await this.load();
        App.setStatus('Deleted masks');
    },

    async mergeSelected() {
        if (this.selectedIds.size < 2) {
            App.showToast('Select at least 2 masks to merge', 'error');
            return;
        }
        if (this.editMode) this.exitEditMode(false);


        await API.post(API.sessionUrl('/masks/merge'), { ids: [...this.selectedIds] });
        this.selectedIds.clear();
        await this.load();
        App.setStatus('Merged masks');
    },

    toggleDraw() {
        if (this.editMode) this.exitEditMode(true);
        this.drawMode = !this.drawMode;
        const btn = document.getElementById('btnDrawMask');
        if (btn) btn.classList.toggle('active', this.drawMode);
        App.setStatus(this.drawMode ? 'Draw mode: click and drag to create a mask' : 'Draw mode off');
    },

    onMouseDown(pointer) {
        if (!this.drawMode) return false;
        this.drawStart = { x: pointer.x, y: pointer.y };
        this.drawRect = new fabric.Rect({
            left: pointer.x, top: pointer.y, width: 0, height: 0,
            fill: 'rgba(79,195,247,0.2)', stroke: '#4fc3f7', strokeWidth: 2,
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


        await API.post(API.sessionUrl('/masks'), { bbox: [x1, y1, x2, y2] });
        await this.load();
        App.setStatus('Created new mask');
    },


    fitView() {
        ImageViewer.fitToScreen();
    },

    deactivate() {
        this.drawMode = false;
        this.exitEditMode(false);
    }
};
