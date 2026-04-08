/**
 * Line Editor - Line detection viewing and editing
 * Supports multi-select (shift+click) and bulk delete.
 */
const LineEditor = {
    solid: [],
    dashed: [],
    directions: {},
    resizedShape: null,
    // Multi-select: set of keys like "solid_0", "dashed_3"
    selectedKeys: new Set(),
    fabricLines: [],
    // Edit mode: drag endpoints
    editMode: false,
    editKey: null,
    editHandles: null,  // { p1: fabric.Circle, p2: fabric.Circle, line: fabric.Line }
    drawMode: false,
    drawStart: null,
    drawLine: null,
    drawLineType: 'solid',

    /** Scale line coords from resized space to image space */
    _s(coords) {
        const s = App.coordScale;
        return [coords[0] * s, coords[1] * s, coords[2] * s, coords[3] * s];
    },

    _key(type, idx) { return `${type}_${idx}`; },

    _parseKey(key) {
        const parts = key.split('_');
        return { type: parts[0], idx: parseInt(parts[1]) };
    },

    async load() {
        try {
            const data = await API.get(API.sessionUrl('/lines'));
            this.solid = data.solid || [];
            this.dashed = data.dashed || [];
            this.directions = data.directions || {};
            this.resizedShape = data.resized_shape;
            this.selectedKeys.clear();

            // Update coord scale now that we have line data
            if (ImageViewer.imageWidth > 0) {
                if (this.resizedShape) {
                    App.coordScale = ImageViewer.imageWidth / this.resizedShape[1];
                } else if (data.target_width) {
                    App.coordScale = ImageViewer.imageWidth / data.target_width;
                } else if (data.scale) {
                    App.coordScale = 1.0 / data.scale;
                }
            }

            this.render();
            this.updateSidebar();
        } catch (e) {
            App.setStatus('No line detection data available');
        }
    },

    render() {
        ImageViewer.clearOverlays();
        this.fabricLines = [];

        const allLines = [
            ...this.solid.map((l, i) => ({ coords: l, type: 'solid', idx: i })),
            ...this.dashed.map((l, i) => ({ coords: l, type: 'dashed', idx: i })),
        ];

        for (const item of allLines) {
            const key = this._key(item.type, item.idx);
            // Skip line being edited — it has interactive handles
            if (this.editMode && this.editKey === key) continue;

            const [x1, y1, x2, y2] = this._s(item.coords);
            const isSel = this.selectedKeys.has(key);
            const color = isSel ? '#ff0000' : (item.type === 'solid' ? '#4fc3f7' : '#ff9800');

            const line = new fabric.Line([x1, y1, x2, y2], {
                stroke: color,
                strokeWidth: isSel ? 3 : 1.5,
                strokeDashArray: item.type === 'dashed' ? [8, 4] : null,
                selectable: false,
                evented: false,
            });
            ImageViewer.addObject(line);
            this.fabricLines.push({ obj: line, ...item });

            // Draw direction arrow if present
            const dir = this.directions[key];
            if (dir && dir !== 'none') {
                this._drawArrow(x1, y1, x2, y2, dir, isSel ? '#ff0000' : '#ffeb3b');
            }
        }

        // If in edit mode, add the interactive handles on top
        if (this.editMode && this.editHandles) {
            ImageViewer.addObject(this.editHandles.line);
            ImageViewer.addObject(this.editHandles.p1);
            ImageViewer.addObject(this.editHandles.p2);
        }

        ImageViewer.render();
    },

    _drawArrow(x1, y1, x2, y2, direction, color) {
        let ax, ay, angle;
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;

        if (direction === 'forward') {
            ax = mx + (x2 - x1) * 0.1;
            ay = my + (y2 - y1) * 0.1;
            angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
        } else if (direction === 'backward') {
            ax = mx - (x2 - x1) * 0.1;
            ay = my - (y2 - y1) * 0.1;
            angle = Math.atan2(y1 - y2, x1 - x2) * 180 / Math.PI;
        } else { // bidirectional
            this._drawArrowHead(mx + (x2-x1)*0.1, my + (y2-y1)*0.1,
                Math.atan2(y2-y1, x2-x1) * 180 / Math.PI, color);
            this._drawArrowHead(mx - (x2-x1)*0.1, my - (y2-y1)*0.1,
                Math.atan2(y1-y2, x1-x2) * 180 / Math.PI, color);
            return;
        }
        this._drawArrowHead(ax, ay, angle, color);
    },

    _drawArrowHead(x, y, angleDeg, color) {
        const size = 10;
        const rad = angleDeg * Math.PI / 180;
        const points = [
            { x: x + size * Math.cos(rad), y: y + size * Math.sin(rad) },
            { x: x + size * 0.6 * Math.cos(rad + 2.4), y: y + size * 0.6 * Math.sin(rad + 2.4) },
            { x: x + size * 0.6 * Math.cos(rad - 2.4), y: y + size * 0.6 * Math.sin(rad - 2.4) },
        ];
        const triangle = new fabric.Polygon(points, {
            fill: color, selectable: false, evented: false,
        });
        ImageViewer.addObject(triangle);
    },

    onClick(pointer) {
        if (this.drawMode || this.editMode) return;

        const x = pointer.x, y = pointer.y;
        let bestDist = 15; // click tolerance in pixels (in image coords)
        let bestKey = null;

        const allLines = [
            ...this.solid.map((l, i) => ({ coords: l, type: 'solid', idx: i })),
            ...this.dashed.map((l, i) => ({ coords: l, type: 'dashed', idx: i })),
        ];

        for (const item of allLines) {
            const [x1, y1, x2, y2] = this._s(item.coords);
            const dist = this._pointToLineDist(x, y, x1, y1, x2, y2);
            if (dist < bestDist) {
                bestDist = dist;
                bestKey = this._key(item.type, item.idx);
            }
        }

        if (bestKey !== null) {
            if (this.selectedKeys.has(bestKey)) {
                this.selectedKeys.delete(bestKey);
            } else {
                if (!App.shiftKey) this.selectedKeys.clear();
                this.selectedKeys.add(bestKey);
            }
        } else if (!App.shiftKey) {
            this.selectedKeys.clear();
        }

        this.render();
        this.updateSidebar();
    },

    _pointToLineDist(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        if (len2 === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    },

    updateSidebar() {
        document.getElementById('sidebarTitle').textContent = 'Lines';
        document.getElementById('sidebarCount').textContent =
            `${this.solid.length} solid, ${this.dashed.length} dashed | ${this.selectedKeys.size} selected`;

        let html = '<div style="padding:4px 8px;font-size:12px;color:#888">Solid Lines</div>';
        for (let i = 0; i < this.solid.length; i++) {
            const key = this._key('solid', i);
            const sel = this.selectedKeys.has(key) ? 'selected' : '';
            const dir = this.directions[key] || '';
            html += `<div class="list-item ${sel}" onclick="LineEditor.select('solid',${i})">
                <span class="label">S#${i} [${this.solid[i].join(',')}]</span>
                <span class="score">${dir || '-'}</span>
            </div>`;
        }

        html += '<div style="padding:4px 8px;font-size:12px;color:#888;margin-top:8px">Dashed Lines</div>';
        for (let i = 0; i < this.dashed.length; i++) {
            const key = this._key('dashed', i);
            const sel = this.selectedKeys.has(key) ? 'selected' : '';
            const dir = this.directions[key] || '';
            html += `<div class="list-item ${sel}" onclick="LineEditor.select('dashed',${i})">
                <span class="label">D#${i} [${this.dashed[i].join(',')}]</span>
                <span class="score">${dir || '-'}</span>
            </div>`;
        }

        if (this.editMode && this.editKey) {
            html += `<div class="details-panel" style="border-top:2px solid #4fc3f7">
                <div style="color:#4fc3f7;font-weight:600;margin-bottom:6px">Editing Line</div>
                <div style="font-size:12px;color:#aaa;margin-bottom:8px">
                    Drag the endpoint circles to reposition the line.
                </div>
                <button class="btn primary" style="width:100%" onclick="LineEditor.finishEdit()">Done Editing</button>
                <button class="btn" style="width:100%;margin-top:4px" onclick="LineEditor.cancelEdit()">Cancel</button>
            </div>`;
        } else if (this.selectedKeys.size === 1) {
            const { type, idx } = this._parseKey([...this.selectedKeys][0]);
            const coords = (type === 'solid' ? this.solid : this.dashed)[idx];
            const dirKey = this._key(type, idx);
            const dir = this.directions[dirKey] || 'none';
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Type:</span><span>${type}</span></div>
                <div class="detail-row"><span class="detail-label">Coords:</span><span>${coords.join(', ')}</span></div>
                <div class="detail-row"><span class="detail-label">Direction:</span><span>${dir}</span></div>
            </div>`;
        } else if (this.selectedKeys.size > 1) {
            html += `<div class="details-panel">
                <div class="detail-row"><span class="detail-label">Selected:</span><span>${this.selectedKeys.size} line(s)</span></div>
                <div style="margin-top:8px;font-size:12px;color:#888">
                    Use "Delete Selected" to remove all selected lines.
                </div>
            </div>`;
        }

        document.getElementById('sidebarContent').innerHTML = html;
    },

    select(type, idx) {
        const key = this._key(type, idx);
        if (this.selectedKeys.has(key)) {
            this.selectedKeys.delete(key);
        } else {
            if (!App.shiftKey) this.selectedKeys.clear();
            this.selectedKeys.add(key);
        }
        this.render();
        this.updateSidebar();
    },

    // ---- Edit mode: drag endpoints ----

    editSelected() {
        if (this.selectedKeys.size !== 1) {
            App.showToast('Select exactly one line to edit', 'error');
            return;
        }
        const key = [...this.selectedKeys][0];
        const { type, idx } = this._parseKey(key);
        const coords = (type === 'solid' ? this.solid : this.dashed)[idx];
        if (!coords) return;

        this._saveUndo();
        this.editMode = true;
        this.editKey = key;

        const [x1, y1, x2, y2] = this._s(coords);
        const handleRadius = 8;

        // Create draggable endpoint circles
        const p1 = new fabric.Circle({
            left: x1 - handleRadius, top: y1 - handleRadius,
            radius: handleRadius,
            fill: '#4fc3f7', stroke: '#fff', strokeWidth: 2,
            originX: 'center', originY: 'center',
            left: x1, top: y1,
            selectable: true, evented: true,
            hasControls: false, hasBorders: false,
            hoverCursor: 'grab', moveCursor: 'grabbing',
        });

        const p2 = new fabric.Circle({
            radius: handleRadius,
            fill: '#4fc3f7', stroke: '#fff', strokeWidth: 2,
            originX: 'center', originY: 'center',
            left: x2, top: y2,
            selectable: true, evented: true,
            hasControls: false, hasBorders: false,
            hoverCursor: 'grab', moveCursor: 'grabbing',
        });

        // Visual line connecting the handles
        const editLine = new fabric.Line([x1, y1, x2, y2], {
            stroke: '#4fc3f7', strokeWidth: 2.5,
            strokeDashArray: [6, 3],
            selectable: false, evented: false,
        });

        // Update visual line when handles are dragged
        const updateLine = () => {
            editLine.set({ x1: p1.left, y1: p1.top, x2: p2.left, y2: p2.top });
            editLine.setCoords();
            ImageViewer.render();
        };
        p1.on('moving', updateLine);
        p2.on('moving', updateLine);

        this.editHandles = { p1, p2, line: editLine };

        document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        this.render();
        this.updateSidebar();
        App.setStatus('Editing line — drag endpoints to reposition');
    },

    async finishEdit() {
        if (!this.editMode || !this.editHandles) return;

        const { p1, p2 } = this.editHandles;
        const { type, idx } = this._parseKey(this.editKey);

        // Convert back from image coords to resized coords
        const invS = 1.0 / App.coordScale;
        const newCoords = [
            Math.round(p1.left * invS),
            Math.round(p1.top * invS),
            Math.round(p2.left * invS),
            Math.round(p2.top * invS),
        ];

        await API.put(API.sessionUrl(`/lines/${type}/${idx}`), { line: newCoords });

        // Update local data
        const arr = type === 'solid' ? this.solid : this.dashed;
        if (arr[idx]) arr[idx] = newCoords;

        const editedKey = this.editKey;
        this.exitEditMode(true);
        this.selectedKeys.clear();
        this.selectedKeys.add(editedKey);
        this.render();
        this.updateSidebar();
        document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        App.setStatus('Line updated');
    },

    cancelEdit() {
        this.exitEditMode(true);
        App.setStatus('Edit cancelled');
    },

    exitEditMode(rerender) {
        if (this.editHandles) {
            ImageViewer.canvas.discardActiveObject();
            ImageViewer.removeObject(this.editHandles.p1);
            ImageViewer.removeObject(this.editHandles.p2);
            ImageViewer.removeObject(this.editHandles.line);
            this.editHandles = null;
        }
        this.editMode = false;
        this.editKey = null;
        if (rerender) {
            this.render();
            this.updateSidebar();
            document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        }
    },

    clearSelection() {
        if (this.editMode) this.exitEditMode(false);
        this.selectedKeys.clear();
        this.render();
        this.updateSidebar();
    },

    async deleteSelected() {
        if (this.selectedKeys.size === 0) return;
        if (this.editMode) this.exitEditMode(false);
        if (!confirm(`Delete ${this.selectedKeys.size} selected line(s)?`)) return;

        this._saveUndo();

        const items = [...this.selectedKeys].map(k => this._parseKey(k));
        await API.post(API.sessionUrl('/lines/bulk-delete'), { items });

        this.selectedKeys.clear();
        await this.load();
        App.setStatus(`Deleted ${items.length} line(s)`);
    },

    async toggleType() {
        if (this.selectedKeys.size !== 1) {
            App.showToast('Select exactly one line to toggle type', 'error');
            return;
        }
        const { type, idx } = this._parseKey([...this.selectedKeys][0]);
        const newType = type === 'solid' ? 'dashed' : 'solid';
        this._saveUndo();
        await API.put(API.sessionUrl(`/lines/${type}/${idx}`), { new_type: newType });
        this.selectedKeys.clear();
        await this.load();
        App.setStatus('Toggled line type');
    },

    async setDirection(dir) {
        if (this.selectedKeys.size === 0) return;
        this._saveUndo();

        // Apply direction to all selected lines
        for (const key of this.selectedKeys) {
            const { type, idx } = this._parseKey(key);
            await API.put(API.sessionUrl(`/lines/${type}/${idx}`), { direction: dir });
            if (dir === 'none') delete this.directions[key];
            else this.directions[key] = dir;
        }
        this.render();
        this.updateSidebar();
        App.setStatus(`Direction set to ${dir} for ${this.selectedKeys.size} line(s)`);
    },

    toggleDraw() {
        if (this.editMode) this.exitEditMode(true);
        this.drawMode = !this.drawMode;
        const btn = document.getElementById('btnDrawLine');
        if (btn) btn.classList.toggle('active', this.drawMode);
        App.setStatus(this.drawMode ? 'Draw mode: click two points to create a line' : 'Draw mode off');
    },

    onMouseDown(pointer) {
        if (!this.drawMode) return false;

        if (!this.drawStart) {
            this.drawStart = { x: pointer.x, y: pointer.y };
            // Show start point marker
            this.drawLine = new fabric.Circle({
                left: pointer.x - 4, top: pointer.y - 4, radius: 4,
                fill: '#4fc3f7', selectable: false, evented: false,
            });
            ImageViewer.addObject(this.drawLine);
            ImageViewer.render();
            return true;
        } else {
            // Second click - create line
            const x2 = pointer.x, y2 = pointer.y;
            if (this.drawLine) ImageViewer.removeObject(this.drawLine);
            this.drawLine = null;

            // Convert image coords back to resized coords for storage
            const invS = 1.0 / App.coordScale;
            const line = [
                Math.round(this.drawStart.x * invS),
                Math.round(this.drawStart.y * invS),
                Math.round(x2 * invS),
                Math.round(y2 * invS),
            ];
            this.drawStart = null;

            this._saveUndo();
            API.post(API.sessionUrl('/lines'), { line, type: this.drawLineType }).then(() => {
                this.load();
                App.setStatus('Added new line');
            });
            return true;
        }
    },

    _saveUndo() {
        // No-op: undo/redo removed
    },

    getToolbar() {
        if (this.editMode) {
            return `
                <span style="color:#4fc3f7;font-size:14px;padding:6px 12px;font-weight:600">Editing Line</span>
                <span style="color:#888;font-size:13px;padding:6px">Drag endpoints to reposition</span>
                <div class="btn-sep"></div>
                <button class="btn primary" onclick="LineEditor.finishEdit()">Done Editing</button>
                <button class="btn" onclick="LineEditor.cancelEdit()">Cancel</button>
            `;
        }
        return `
            <button class="btn" onclick="LineEditor.clearSelection()">Clear Selection</button>
            <button class="btn" onclick="LineEditor.editSelected()">Edit Line</button>
            <button class="btn danger" onclick="LineEditor.deleteSelected()">Delete Selected</button>
            <button class="btn" onclick="LineEditor.toggleType()">Toggle Solid/Dashed</button>
            <div class="btn-sep"></div>
            <span style="color:#888;font-size:13px;padding:6px">Direction:</span>
            <button class="btn" onclick="LineEditor.setDirection('forward')">Forward &#8594;</button>
            <button class="btn" onclick="LineEditor.setDirection('backward')">&#8592; Backward</button>
            <button class="btn" onclick="LineEditor.setDirection('bidirectional')">&#8596; Both</button>
            <button class="btn" onclick="LineEditor.setDirection('none')">None</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="LineEditor.cleanupLines()">Clean Up Lines</button>
            <div class="btn-sep"></div>
            <button class="btn" id="btnDrawLine" onclick="LineEditor.toggleDraw()">Draw Line</button>
            <select style="padding:4px 8px;background:#1a1a2e;color:#e0e0e0;border:1px solid #3a3a5c;border-radius:6px"
                    onchange="LineEditor.drawLineType=this.value">
                <option value="solid">Solid</option>
                <option value="dashed">Dashed</option>
            </select>
            <div class="btn-sep"></div>
            <button class="btn" onclick="ImageViewer.fitToScreen()">Fit View</button>
        `;
    },

    async cleanupLines() {
        const total = this.solid.length + this.dashed.length;
        if (!confirm(`Clean up ${total} lines?\n\nThis will:\n- Remove very short segments\n- Remove near-duplicate lines\n- Merge collinear connected segments\n\nDirection annotations will be reset.`)) return;

        this._saveUndo();
        App.setStatus('Cleaning up lines...');
        try {
            const result = await API.post(API.sessionUrl('/lines/cleanup'));
            await this.load();
            App.setStatus(`Cleanup done: ${result.before.solid + result.before.dashed} → ${result.after.solid + result.after.dashed} lines (removed ${result.removed})`);
        } catch (e) {
            App.setStatus('Cleanup failed: ' + e.message);
        }
    },

    deactivate() {
        this.drawMode = false;
        this.drawStart = null;
        if (this.drawLine) {
            ImageViewer.removeObject(this.drawLine);
            this.drawLine = null;
        }
        this.exitEditMode(false);
    },
};
