/**
 * Graph Viewer - Visualize and edit digitized P&ID graph with symbol patches as nodes.
 * Nodes are positioned at their original image locations (bbox centers).
 * Uses HTML5 Canvas with pan/zoom.
 * Supports editing: delete symbols, delete connections, add connections.
 */
const GraphViewer = {
    canvas: null,
    ctx: null,
    nodes: [],
    links: [],
    categories: {},   // category -> { color, count }
    patchImages: {},   // mask_id -> Image
    undoMgr: new UndoManager(),
    width: 0,
    height: 0,
    // Bounding box of all node positions (image coords)
    imgMinX: 0, imgMinY: 0, imgMaxX: 1, imgMaxY: 1,

    // Interaction
    isPanning: false,
    panStartX: 0,
    panStartY: 0,
    offsetX: 0,
    offsetY: 0,
    zoom: 1,
    hoveredNode: null,
    hoveredLink: null,

    // Edit mode state
    editMode: null,          // null = view-only, 'select' = select/delete, 'addLink' = add connection
    selectedNode: null,
    selectedLink: null,
    addLinkSource: null,     // first node selected when adding a link
    _panMoved: false,        // track if mouse moved during pan (to distinguish click from drag)

    NODE_SIZE: 48,

    // Color palette for clusters
    COLORS: [
        '#4fc3f7', '#ff7043', '#66bb6a', '#ab47bc', '#ffca28',
        '#26c6da', '#ef5350', '#8d6e63', '#78909c', '#ec407a',
        '#7e57c2', '#29b6f6', '#9ccc65', '#ffa726', '#5c6bc0',
        '#42a5f5', '#d4e157', '#ff8a65', '#bdbdbd', '#26a69a',
    ],

    async load(graphData) {
        const container = document.getElementById('canvasContainer');
        let overlay = document.getElementById('graphOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'graphOverlay';
            overlay.style.cssText = 'position:absolute;inset:0;background:#111;z-index:50;display:flex;flex-direction:column;';
            container.appendChild(overlay);
        }

        overlay.innerHTML = `
            <div id="graphStats" class="graph-stats-bar"></div>
            <div id="graphEditBar" class="graph-edit-bar" style="display:none;"></div>
            <div style="flex:1;position:relative;overflow:hidden;">
                <canvas id="graphCanvas" style="display:block;width:100%;height:100%;"></canvas>
            </div>
        `;

        const canvasEl = document.getElementById('graphCanvas');
        const rect = canvasEl.parentElement.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;
        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = this.width * dpr;
        canvasEl.height = this.height * dpr;
        canvasEl.style.width = this.width + 'px';
        canvasEl.style.height = this.height + 'px';
        this.canvas = canvasEl;
        this.ctx = canvasEl.getContext('2d');
        this.ctx.scale(dpr, dpr);

        this.hoveredNode = null;
        this.hoveredLink = null;
        this.selectedNode = null;
        this.selectedLink = null;
        this.addLinkSource = null;
        this.editMode = null;
        this.undoMgr.clear();

        // Process graph data
        this._processData(graphData);
        this._updateStats();

        // Load patch images
        await this._loadPatches();

        // Position nodes from bboxes and fit to screen
        this._positionFromBboxes();
        this.fitToScreen();

        this._bindEvents();
    },

    _processData(data) {
        const rawNodes = data.nodes || [];
        const rawLinks = data.links || [];

        // Build category color map
        this.categories = {};
        const catSet = new Set();
        rawNodes.forEach(n => catSet.add(n.category || 'unknown'));
        let colorIdx = 0;
        catSet.forEach(cat => {
            this.categories[cat] = {
                color: this.COLORS[colorIdx % this.COLORS.length],
                count: 0,
            };
            colorIdx++;
        });

        // Create node objects
        const nodeMap = {};
        this.nodes = rawNodes.map(n => {
            const cat = n.category || 'unknown';
            this.categories[cat].count++;
            const node = {
                id: n.id,
                category: cat,
                mask_id: n.mask_id,
                bbox: n.bbox,
                captions: n.captions || [],
                cluster_id: n.cluster_id,
                color: this.categories[cat].color,
                x: 0, y: 0,
            };
            nodeMap[n.id] = node;
            return node;
        });

        // Create link objects — store raw source/target IDs for API calls
        this.links = rawLinks.map(l => ({
            source: nodeMap[l.source],
            target: nodeMap[l.target],
            sourceId: l.source,
            targetId: l.target,
            type: l.type || 'solid',
            direction: l.direction || 'none',
        })).filter(l => l.source && l.target);
    },

    /** Position each node at its bbox center; compute node w/h from bbox. */
    _positionFromBboxes() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (const node of this.nodes) {
            if (node.bbox && node.bbox.length === 4) {
                const [x1, y1, x2, y2] = node.bbox;
                node.x = (x1 + x2) / 2;
                node.y = (y1 + y2) / 2;
                node.w = x2 - x1;
                node.h = y2 - y1;
            } else {
                node.w = this.NODE_SIZE;
                node.h = this.NODE_SIZE;
            }
            if (node.x < minX) minX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.x > maxX) maxX = node.x;
            if (node.y > maxY) maxY = node.y;
        }

        // Store image extent (with padding)
        const pad = 150;
        this.imgMinX = minX - pad;
        this.imgMinY = minY - pad;
        this.imgMaxX = maxX + pad;
        this.imgMaxY = maxY + pad;
    },

    fitToScreen() {
        const imgW = this.imgMaxX - this.imgMinX || 1;
        const imgH = this.imgMaxY - this.imgMinY || 1;
        this.zoom = Math.min(this.width / imgW, this.height / imgH) * 0.95;
        this.offsetX = (this.width - imgW * this.zoom) / 2 - this.imgMinX * this.zoom;
        this.offsetY = (this.height - imgH * this.zoom) / 2 - this.imgMinY * this.zoom;
        this.draw();
    },

    _updateStats() {
        const statsEl = document.getElementById('graphStats');
        if (!statsEl) return;

        let legendHtml = '';
        for (const [cat, info] of Object.entries(this.categories)) {
            legendHtml += `<span class="graph-legend-item">
                <span class="graph-legend-dot" style="background:${info.color}"></span>
                ${cat} (${info.count})
            </span>`;
        }

        statsEl.innerHTML = `
            <div class="graph-stats-left">
                <span><strong>${this.nodes.length}</strong> Nodes</span>
                <span style="margin:0 8px;color:#555">|</span>
                <span><strong>${this.links.length}</strong> Links</span>
            </div>
            <div class="graph-legend">${legendHtml}</div>
        `;
    },

    async _loadPatches() {
        const promises = [];
        for (const node of this.nodes) {
            if (node.mask_id == null) continue;
            const url = API.sessionUrl(`/masks/${node.mask_id}/patch`);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            const p = new Promise(resolve => {
                img.onload = () => { this.patchImages[node.mask_id] = img; resolve(); };
                img.onerror = () => resolve();
            });
            img.src = url;
            promises.push(p);
        }
        await Promise.all(promises);
    },

    draw() {
        const ctx = this.ctx;
        const w = this.width;
        const h = this.height;
        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);

        // Apply pan/zoom
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.zoom, this.zoom);

        const invZ = 1 / this.zoom;

        // Draw links
        for (const link of this.links) {
            const sx = link.source.x, sy = link.source.y;
            const tx = link.target.x, ty = link.target.y;
            const isHovered = link === this.hoveredLink;
            const isSelected = link === this.selectedLink;

            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(tx, ty);
            if (isSelected) {
                ctx.strokeStyle = '#ef5350';
                ctx.lineWidth = 5 * invZ;
            } else if (isHovered && this.editMode) {
                ctx.strokeStyle = '#4fc3f7';
                ctx.lineWidth = 4 * invZ;
            } else if (isHovered) {
                ctx.strokeStyle = '#4fc3f7';
                ctx.lineWidth = 4 * invZ;
            } else {
                ctx.strokeStyle = link.type === 'dashed' ? '#ff9800' : 'rgba(255,255,255,0.35)';
                ctx.lineWidth = 2 * invZ;
            }
            if (link.type === 'dashed') {
                ctx.setLineDash([8 * invZ, 5 * invZ]);
            } else {
                ctx.setLineDash([]);
            }
            ctx.stroke();
            ctx.setLineDash([]);

            if (link.direction && link.direction !== 'none') {
                this._drawArrow(ctx, sx, sy, tx, ty, link.direction);
            }
        }

        // Draw "add link" preview line from source to cursor
        if (this.editMode === 'addLink' && this.addLinkSource && this._lastWorldPos) {
            ctx.beginPath();
            ctx.moveTo(this.addLinkSource.x, this.addLinkSource.y);
            ctx.lineTo(this._lastWorldPos.x, this._lastWorldPos.y);
            ctx.strokeStyle = '#66bb6a';
            ctx.lineWidth = 3 * invZ;
            ctx.setLineDash([6 * invZ, 4 * invZ]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw nodes
        for (const node of this.nodes) {
            const nw = node.w;
            const nh = node.h;
            const x = node.x - nw / 2;
            const y = node.y - nh / 2;

            const isSelected = node === this.selectedNode;
            const isAddLinkSource = node === this.addLinkSource;

            // Border (cluster color, or selection highlight)
            let borderW, borderColor;
            if (isSelected) {
                borderW = 5;
                borderColor = '#ef5350';
            } else if (isAddLinkSource) {
                borderW = 5;
                borderColor = '#66bb6a';
            } else if (node === this.hoveredNode) {
                borderW = 4;
                borderColor = node.color;
            } else {
                borderW = 2.5;
                borderColor = node.color;
            }
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = borderW * invZ;
            ctx.strokeRect(x - 1, y - 1, nw + 2, nh + 2);

            // Patch image or colored box
            const img = this.patchImages[node.mask_id];
            if (img) {
                ctx.drawImage(img, x, y, nw, nh);
            } else {
                ctx.fillStyle = node.color + '33';
                ctx.fillRect(x, y, nw, nh);
                ctx.fillStyle = node.color;
                ctx.font = `${Math.max(10, nw * 0.2)}px monospace`;
                ctx.textAlign = 'center';
                ctx.fillText(node.category, node.x, node.y + 3);
            }

            // Caption label below node (text detections assigned to this symbol)
            const fontSize = 14 * invZ;
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.textAlign = 'center';
            if (node.captions && node.captions.length > 0) {
                for (let ci = 0; ci < node.captions.length; ci++) {
                    const cap = node.captions[ci];
                    const truncated = cap.length > 30 ? cap.slice(0, 28) + '..' : cap;
                    const ty = y + nh + fontSize * (ci + 1) + 4 * invZ;
                    // Dark background for readability
                    const tw = ctx.measureText(truncated).width;
                    ctx.fillStyle = 'rgba(0,0,0,0.7)';
                    ctx.fillRect(node.x - tw / 2 - 2 * invZ, ty - fontSize + 2 * invZ, tw + 4 * invZ, fontSize + 2 * invZ);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(truncated, node.x, ty);
                }
            }
        }

        // Tooltip for hovered node or link (only when not in addLink mode with source selected)
        if (this.editMode === 'addLink' && this.addLinkSource) {
            // Show a hint near cursor
        } else if (this.hoveredNode) {
            this._drawTooltip(ctx, this.hoveredNode);
        } else if (this.hoveredLink) {
            this._drawLinkTooltip(ctx, this.hoveredLink);
        }

        ctx.restore();
    },

    _drawArrow(ctx, sx, sy, tx, ty, direction) {
        const invZ = 1 / this.zoom;
        const headLen = 10 * invZ;
        const draw = (fx, fy, toX, toY) => {
            const angle = Math.atan2(toY - fy, toX - fx);
            const mx = (fx + toX) / 2 + (toX - fx) * 0.15;
            const my = (fy + toY) / 2 + (toY - fy) * 0.15;
            ctx.beginPath();
            ctx.moveTo(mx, my);
            ctx.lineTo(mx - headLen * Math.cos(angle - 0.4), my - headLen * Math.sin(angle - 0.4));
            ctx.moveTo(mx, my);
            ctx.lineTo(mx - headLen * Math.cos(angle + 0.4), my - headLen * Math.sin(angle + 0.4));
            ctx.strokeStyle = '#aaa';
            ctx.lineWidth = 1.5 * invZ;
            ctx.stroke();
        };

        if (direction === 'forward' || direction === 'going_out') {
            draw(sx, sy, tx, ty);
        } else if (direction === 'backward' || direction === 'coming_in') {
            draw(tx, ty, sx, sy);
        } else if (direction === 'bidirectional') {
            draw(sx, sy, tx, ty);
            draw(tx, ty, sx, sy);
        }
    },

    _drawTooltip(ctx, node) {
        const invZ = 1 / this.zoom;
        const x = node.x + node.w / 2 + 10;
        const y = node.y - 10;
        const lines = [
            `ID: ${node.id}`,
            `Category: ${node.category}`,
        ];
        if (node.captions.length > 0) {
            lines.push(`Captions: ${node.captions.join(', ')}`);
        }
        if (node.cluster_id != null) {
            lines.push(`Cluster: ${node.cluster_id}`);
        }

        const fontSize = 12 * invZ;
        ctx.font = `${fontSize}px sans-serif`;
        const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
        const padding = 6 * invZ;
        const lineH = fontSize * 1.4;
        const boxW = maxW + padding * 2;
        const boxH = lines.length * lineH + padding * 2;

        ctx.fillStyle = 'rgba(22, 33, 62, 0.95)';
        ctx.strokeStyle = '#4fc3f7';
        ctx.lineWidth = 1 * invZ;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(x, y, boxW, boxH, 4 * invZ);
        } else {
            ctx.rect(x, y, boxW, boxH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#e0e0e0';
        ctx.textAlign = 'left';
        lines.forEach((line, i) => {
            ctx.fillText(line, x + padding, y + padding + (i + 0.8) * lineH);
        });
    },

    _drawLinkTooltip(ctx, link) {
        const invZ = 1 / this.zoom;
        const mx = (link.source.x + link.target.x) / 2 + 10 * invZ;
        const my = (link.source.y + link.target.y) / 2 - 10 * invZ;

        const srcLabel = link.source.captions.length > 0 ? link.source.captions[0] : `#${link.source.id} (${link.source.category})`;
        const tgtLabel = link.target.captions.length > 0 ? link.target.captions[0] : `#${link.target.id} (${link.target.category})`;
        const lines = [
            `Source: ${srcLabel}`,
            `Target: ${tgtLabel}`,
            `Type: ${link.type}`,
        ];
        if (link.direction && link.direction !== 'none') {
            lines.push(`Direction: ${link.direction}`);
        }

        const fontSize = 12 * invZ;
        ctx.font = `${fontSize}px sans-serif`;
        const maxW = Math.max(...lines.map(l => ctx.measureText(l).width));
        const padding = 6 * invZ;
        const lineH = fontSize * 1.4;
        const boxW = maxW + padding * 2;
        const boxH = lines.length * lineH + padding * 2;

        ctx.fillStyle = 'rgba(22, 33, 62, 0.95)';
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 1 * invZ;
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(mx, my, boxW, boxH, 4 * invZ);
        } else {
            ctx.rect(mx, my, boxW, boxH);
        }
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#e0e0e0';
        ctx.textAlign = 'left';
        lines.forEach((line, i) => {
            ctx.fillText(line, mx + padding, my + padding + (i + 0.8) * lineH);
        });
    },

    _bindEvents() {
        const canvas = this.canvas;

        // Remove old listeners by replacing element
        const newCanvas = canvas.cloneNode(true);
        canvas.parentNode.replaceChild(newCanvas, canvas);
        this.canvas = newCanvas;
        this.ctx = newCanvas.getContext('2d');
        this.ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

        newCanvas.addEventListener('mousedown', (e) => this._onMouseDown(e));
        newCanvas.addEventListener('mousemove', (e) => this._onMouseMove(e));
        newCanvas.addEventListener('mouseup', (e) => this._onMouseUp(e));
        newCanvas.addEventListener('wheel', (e) => this._onWheel(e));
    },

    _screenToWorld(sx, sy) {
        return {
            x: (sx - this.offsetX) / this.zoom,
            y: (sy - this.offsetY) / this.zoom,
        };
    },

    _nodeAt(wx, wy) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const n = this.nodes[i];
            const hw = n.w / 2, hh = n.h / 2;
            if (wx >= n.x - hw && wx <= n.x + hw && wy >= n.y - hh && wy <= n.y + hh) {
                return n;
            }
        }
        return null;
    },

    _linkAt(wx, wy) {
        const threshold = 10 / this.zoom;
        for (const link of this.links) {
            const ax = link.source.x, ay = link.source.y;
            const bx = link.target.x, by = link.target.y;
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            if (lenSq === 0) continue;
            let t = ((wx - ax) * dx + (wy - ay) * dy) / lenSq;
            t = Math.max(0, Math.min(1, t));
            const px = ax + t * dx, py = ay + t * dy;
            const dist = Math.sqrt((wx - px) ** 2 + (wy - py) ** 2);
            if (dist < threshold) return link;
        }
        return null;
    },

    _onMouseDown(e) {
        if (e.button !== 0) return;
        this.isPanning = true;
        this._panMoved = false;
        this.panStartX = e.clientX;
        this.panStartY = e.clientY;
    },

    _onMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const { x: wx, y: wy } = this._screenToWorld(sx, sy);
        this._lastWorldPos = { x: wx, y: wy };

        if (this.isPanning) {
            const dx = e.clientX - this.panStartX;
            const dy = e.clientY - this.panStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._panMoved = true;
            this.offsetX += dx;
            this.offsetY += dy;
            this.panStartX = e.clientX;
            this.panStartY = e.clientY;
            this.draw();
        } else {
            const node = this._nodeAt(wx, wy);
            const link = node ? null : this._linkAt(wx, wy);
            if (node !== this.hoveredNode || link !== this.hoveredLink) {
                this.hoveredNode = node;
                this.hoveredLink = link;
                if (this.editMode === 'addLink') {
                    this.canvas.style.cursor = node ? 'crosshair' : 'crosshair';
                } else if (this.editMode === 'select') {
                    this.canvas.style.cursor = (node || link) ? 'pointer' : 'default';
                } else {
                    this.canvas.style.cursor = (node || link) ? 'pointer' : 'default';
                }
                this.draw();
            }
            // Redraw for addLink preview line even if hover didn't change
            if (this.editMode === 'addLink' && this.addLinkSource) {
                this.draw();
            }
        }
    },

    _onMouseUp(e) {
        const wasPanning = this.isPanning;
        this.isPanning = false;

        if (wasPanning && this._panMoved) return;
        if (e.button !== 0) return;

        // This is a click (not a drag)
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const { x: wx, y: wy } = this._screenToWorld(sx, sy);

        if (this.editMode === 'select') {
            this._handleSelectClick(wx, wy);
        } else if (this.editMode === 'addLink') {
            this._handleAddLinkClick(wx, wy);
        }
    },

    _handleSelectClick(wx, wy) {
        const node = this._nodeAt(wx, wy);
        const link = node ? null : this._linkAt(wx, wy);

        if (node) {
            this.selectedNode = (this.selectedNode === node) ? null : node;
            this.selectedLink = null;
        } else if (link) {
            this.selectedLink = (this.selectedLink === link) ? null : link;
            this.selectedNode = null;
        } else {
            this.selectedNode = null;
            this.selectedLink = null;
        }
        this._updateEditBar();
        this.draw();
    },

    _handleAddLinkClick(wx, wy) {
        const node = this._nodeAt(wx, wy);
        if (!node) return;

        if (!this.addLinkSource) {
            // First click: select source
            this.addLinkSource = node;
            this._updateEditBar();
            this.draw();
        } else {
            // Second click: select target and create link
            if (node === this.addLinkSource) {
                // Clicked same node — cancel
                App.showToast('Cannot create self-loop. Click a different node.', 'error');
                return;
            }
            this._createLink(this.addLinkSource, node);
        }
    },

    // ---- Edit Mode Controls ----

    setEditMode(mode) {
        this.editMode = mode;
        this.selectedNode = null;
        this.selectedLink = null;
        this.addLinkSource = null;
        this._lastWorldPos = null;

        // Update toolbar button states
        document.getElementById('editorToolbar').innerHTML = this.getToolbar();
        this._updateEditBar();
        this.draw();

        if (mode === 'addLink') {
            this.canvas.style.cursor = 'crosshair';
        } else {
            this.canvas.style.cursor = 'default';
        }
    },

    _updateEditBar() {
        const bar = document.getElementById('graphEditBar');
        if (!bar) return;

        if (!this.editMode) {
            bar.style.display = 'none';
            bar.innerHTML = '';
            return;
        }

        bar.style.display = 'flex';

        if (this.editMode === 'select') {
            if (this.selectedNode) {
                const n = this.selectedNode;
                const label = n.captions.length > 0 ? n.captions[0] : n.category;
                bar.innerHTML = `
                    <span class="graph-edit-info">Selected: <strong>#${n.id} ${label}</strong></span>
                    <button class="btn danger" onclick="GraphViewer.deleteSelectedNode()">Delete Symbol</button>
                    <span class="graph-edit-hint">Press Delete key or click button to remove</span>
                `;
            } else if (this.selectedLink) {
                const l = this.selectedLink;
                const srcLabel = l.source.captions.length > 0 ? l.source.captions[0] : `#${l.source.id}`;
                const tgtLabel = l.target.captions.length > 0 ? l.target.captions[0] : `#${l.target.id}`;
                bar.innerHTML = `
                    <span class="graph-edit-info">Selected link: <strong>${srcLabel} → ${tgtLabel}</strong></span>
                    <button class="btn danger" onclick="GraphViewer.deleteSelectedLink()">Delete Connection</button>
                    <span class="graph-edit-hint">Press Delete key or click button to remove</span>
                `;
            } else {
                bar.innerHTML = `
                    <span class="graph-edit-hint">Click a symbol or connection to select it, then delete.</span>
                `;
            }
        } else if (this.editMode === 'addLink') {
            if (this.addLinkSource) {
                const n = this.addLinkSource;
                const label = n.captions.length > 0 ? n.captions[0] : `#${n.id} (${n.category})`;
                bar.innerHTML = `
                    <span class="graph-edit-info">Source: <strong>${label}</strong></span>
                    <span class="graph-edit-hint">Now click the target symbol to create a connection. Press Esc to cancel.</span>
                `;
            } else {
                bar.innerHTML = `
                    <span class="graph-edit-hint">Click the source symbol for the new connection.</span>
                `;
            }
        }
    },

    async deleteSelectedNode() {
        if (!this.selectedNode) return;
        const node = this.selectedNode;

        this._saveUndo();
        try {
            await API.del(API.sessionUrl(`/graph/node/${node.id}`));

            // Remove locally
            this.links = this.links.filter(l => l.source !== node && l.target !== node);
            this.nodes = this.nodes.filter(n => n !== node);

            // Update category counts
            if (this.categories[node.category]) {
                this.categories[node.category].count--;
            }

            this.selectedNode = null;
            this._updateStats();
            this._updateEditBar();
            this.draw();
            App.showToast(`Deleted symbol #${node.id} (${node.category})`, 'success');
        } catch (e) {
            App.showToast('Failed to delete symbol: ' + e.message, 'error');
        }
    },

    async deleteSelectedLink() {
        if (!this.selectedLink) return;
        const link = this.selectedLink;

        this._saveUndo();
        try {
            const res = await fetch(API.sessionUrl('/graph/link'), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source: link.sourceId, target: link.targetId }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: res.statusText }));
                throw new Error(err.error || res.statusText);
            }
        } catch (e) {
            App.showToast('Failed to delete connection: ' + e.message, 'error');
            return;
        }

        // Remove locally
        this.links = this.links.filter(l => l !== link);
        this.selectedLink = null;
        this._updateStats();
        this._updateEditBar();
        this.draw();

        const srcLabel = link.source.captions.length > 0 ? link.source.captions[0] : `#${link.source.id}`;
        const tgtLabel = link.target.captions.length > 0 ? link.target.captions[0] : `#${link.target.id}`;
        App.showToast(`Deleted connection: ${srcLabel} → ${tgtLabel}`, 'success');
    },

    async _createLink(sourceNode, targetNode) {
        this._saveUndo();
        try {
            const res = await API.post(API.sessionUrl('/graph/link'), {
                source: sourceNode.id,
                target: targetNode.id,
                type: 'solid',
                direction: 'none',
            });

            // Add locally
            this.links.push({
                source: sourceNode,
                target: targetNode,
                sourceId: sourceNode.id,
                targetId: targetNode.id,
                type: 'solid',
                direction: 'none',
            });

            this.addLinkSource = null;
            this._updateStats();
            this._updateEditBar();
            this.draw();

            const srcLabel = sourceNode.captions.length > 0 ? sourceNode.captions[0] : `#${sourceNode.id}`;
            const tgtLabel = targetNode.captions.length > 0 ? targetNode.captions[0] : `#${targetNode.id}`;
            App.showToast(`Added connection: ${srcLabel} → ${tgtLabel}`, 'success');
        } catch (e) {
            App.showToast('Failed to add connection: ' + e.message, 'error');
        }
    },

    /** Serialize current graph state for undo snapshots (raw data, no object references) */
    _snapshotState() {
        return {
            nodes: this.nodes.map(n => ({
                id: n.id, category: n.category, mask_id: n.mask_id,
                bbox: n.bbox, captions: [...n.captions],
                cluster_id: n.cluster_id, color: n.color,
                x: n.x, y: n.y, w: n.w, h: n.h,
            })),
            links: this.links.map(l => ({
                sourceId: l.sourceId, targetId: l.targetId,
                type: l.type, direction: l.direction,
            })),
        };
    },

    /** Restore graph state from a snapshot */
    _restoreState(state) {
        const nodeMap = {};
        this.nodes = state.nodes.map(n => {
            const node = { ...n, captions: [...n.captions] };
            nodeMap[n.id] = node;
            return node;
        });
        this.links = state.links.map(l => ({
            source: nodeMap[l.sourceId],
            target: nodeMap[l.targetId],
            sourceId: l.sourceId,
            targetId: l.targetId,
            type: l.type,
            direction: l.direction,
        })).filter(l => l.source && l.target);

        // Rebuild category counts
        this.categories = {};
        for (const n of this.nodes) {
            if (!this.categories[n.category]) {
                this.categories[n.category] = { color: n.color, count: 0 };
            }
            this.categories[n.category].count++;
        }
    },

    _saveUndo() {
        this.undoMgr.snapshot(this._snapshotState());
    },

    async undo() {
        const prev = this.undoMgr.undo(this._snapshotState());
        if (!prev) { App.showToast('Nothing to undo', 'error'); return; }
        this._restoreState(prev);
        await this._syncToServer();
        this.selectedNode = null;
        this.selectedLink = null;
        this._updateStats();
        this._updateEditBar();
        this.draw();
        App.showToast('Undo', 'success');
    },

    async redo() {
        const next = this.undoMgr.redo(this._snapshotState());
        if (!next) { App.showToast('Nothing to redo', 'error'); return; }
        this._restoreState(next);
        await this._syncToServer();
        this.selectedNode = null;
        this.selectedLink = null;
        this._updateStats();
        this._updateEditBar();
        this.draw();
        App.showToast('Redo', 'success');
    },

    async _syncToServer() {
        // Build raw nodes/links for the bulk API
        const rawNodes = this.nodes.map(n => ({
            id: n.id, category: n.category, mask_id: n.mask_id,
            bbox: n.bbox, captions: n.captions, cluster_id: n.cluster_id,
        }));
        const rawLinks = this.links.map(l => ({
            source: l.sourceId, target: l.targetId,
            type: l.type, direction: l.direction,
        }));
        await API.put(API.sessionUrl('/graph/bulk'), { nodes: rawNodes, links: rawLinks });
    },

    handleKeyDown(e) {
        // Undo/redo works regardless of edit mode
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') { this.undo(); return true; }
            if (e.key === 'y') { this.redo(); return true; }
        }

        if (!this.editMode) return false;

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.editMode === 'select') {
                if (this.selectedNode) {
                    this.deleteSelectedNode();
                    return true;
                }
                if (this.selectedLink) {
                    this.deleteSelectedLink();
                    return true;
                }
            }
        }

        if (e.key === 'Escape') {
            if (this.editMode === 'addLink' && this.addLinkSource) {
                this.addLinkSource = null;
                this._updateEditBar();
                this.draw();
                return true;
            }
            // Exit edit mode
            this.setEditMode(null);
            return true;
        }

        return false;
    },

    _onWheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;

        const oldZoom = this.zoom;
        const factor = e.deltaY > 0 ? 0.92 : 1.08;
        this.zoom = Math.min(Math.max(0.05, this.zoom * factor), 20);

        // Zoom toward cursor
        this.offsetX = sx - (sx - this.offsetX) * (this.zoom / oldZoom);
        this.offsetY = sy - (sy - this.offsetY) * (this.zoom / oldZoom);

        this.draw();
    },

    getToolbar() {
        const isSelect = this.editMode === 'select';
        const isAddLink = this.editMode === 'addLink';
        const inEdit = isSelect || isAddLink;

        return `
            <button class="btn" onclick="GraphViewer.fitToScreen()">Fit View</button>
            <div class="btn-sep"></div>
            <button class="btn ${isSelect ? 'active' : ''}" onclick="GraphViewer.setEditMode(${isSelect ? 'null' : "'select'"})">
                ${isSelect ? 'Exit Select' : 'Select / Delete'}
            </button>
            <button class="btn ${isAddLink ? 'active' : ''}" onclick="GraphViewer.setEditMode(${isAddLink ? 'null' : "'addLink'"})">
                ${isAddLink ? 'Exit Add Link' : 'Add Connection'}
            </button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="GraphViewer.undo()">Undo</button>
            <button class="btn" onclick="GraphViewer.redo()">Redo</button>
            <div class="btn-sep"></div>
            <button class="btn primary" onclick="App.exportZip()">Export ZIP</button>
            <button class="btn" onclick="App.runDigitize()" style="margin-left:4px">Re-generate Graph</button>
        `;
    },

    destroy() {
        this.nodes = [];
        this.links = [];
        this.patchImages = {};
        this.editMode = null;
        this.selectedNode = null;
        this.selectedLink = null;
        this.addLinkSource = null;
    },
};
