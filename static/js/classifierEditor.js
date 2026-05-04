/**
 * Classification Editor - Cluster viewing and labeling
 * Shows P&ID image with highlighted symbols; cluster details in sidebar.
 */
const ClassifierEditor = {
    clusters: [],
    symbols: [],
    currentClusterIdx: 0,
    selectedSymbolIds: new Set(),
    undoMgr: new UndoManager(),
    _overlayObjects: [],

    async load(preservePosition = false) {
        try {
            const prevClusterId = preservePosition && this.clusters[this.currentClusterIdx]
                ? this.clusters[this.currentClusterIdx].id : null;
            const data = await API.get(API.sessionUrl('/classification'));
            this.clusters = data.clusters || [];
            this.symbols = data.symbols || [];
            this.undoMgr.clear();
            this._restoreClusterPosition(prevClusterId, preservePosition);
            this.selectedSymbolIds.clear();
            this.renderOverlay();
            this.updateSidebar();
        } catch (e) {
            this.showNoData();
        }
    },

    /** Reload data from server without clearing undo history */
    async _reload(preservePosition = false) {
        try {
            const prevClusterId = preservePosition && this.clusters[this.currentClusterIdx]
                ? this.clusters[this.currentClusterIdx].id : null;
            const data = await API.get(API.sessionUrl('/classification'));
            this.clusters = data.clusters || [];
            this.symbols = data.symbols || [];
            this._restoreClusterPosition(prevClusterId, preservePosition);
            this.selectedSymbolIds.clear();
            this.renderOverlay();
            this.updateSidebar();
        } catch (e) {
            this.showNoData();
        }
    },

    _restoreClusterPosition(prevClusterId, preservePosition) {
        if (preservePosition && prevClusterId !== null) {
            const idx = this.clusters.findIndex(c => c.id === prevClusterId);
            this.currentClusterIdx = idx >= 0 ? idx : Math.min(this.currentClusterIdx, this.clusters.length - 1);
        } else if (!preservePosition) {
            this.currentClusterIdx = 0;
        }
    },

    /** Get Fabric rect positioning props for a symbol (supports rotated_bbox) */
    _symRectProps(sym) {
        if (sym.rotated_bbox && sym.rotated_bbox.angle) {
            const rb = sym.rotated_bbox;
            return {
                left: rb.cx, top: rb.cy,
                originX: 'center', originY: 'center',
                width: rb.width, height: rb.height,
                angle: rb.angle,
            };
        }
        const [x1, y1, x2, y2] = sym.bbox;
        return {
            left: (x1 + x2) / 2, top: (y1 + y2) / 2,
            originX: 'center', originY: 'center',
            width: x2 - x1, height: y2 - y1,
            angle: 0,
        };
    },

    renderOverlay() {
        // Draw symbols on the P&ID canvas with highlighting
        ImageViewer.clearOverlays();
        this._overlayObjects = [];

        const cluster = this.clusters[this.currentClusterIdx];
        const currentSymIds = cluster ? new Set(cluster.symbol_ids || []) : new Set();

        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
            '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E9'];

        // Draw all symbols, dimmed if not in current cluster
        for (const sym of this.symbols) {
            if (!sym.bbox) continue;
            const pos = this._symRectProps(sym);
            const symKey = sym.mask_id !== undefined ? sym.mask_id : sym.id;
            const inCurrent = currentSymIds.has(symKey);
            const isSelected = this.selectedSymbolIds.has(symKey);

            const clusterObj = this.clusters.find(c => c.id === sym.cluster_id);
            const cidx = this.clusters.indexOf(clusterObj);
            const baseColor = cidx >= 0 ? colors[cidx % colors.length] : '#888';

            if (isSelected) {
                // Selected symbol: outer glow ring
                const pad = 6;
                const glow = new fabric.Rect({
                    ...pos,
                    width: pos.width + pad * 2, height: pos.height + pad * 2,
                    fill: 'transparent', stroke: '#FFD700', strokeWidth: 3,
                    strokeDashArray: [6, 3],
                    opacity: 0.9, selectable: false, evented: false,
                });
                ImageViewer.addObject(glow);

                const rect = new fabric.Rect({
                    ...pos,
                    fill: '#FFD70044', stroke: '#FFD700', strokeWidth: 3,
                    opacity: 1, selectable: false, evented: false,
                });
                ImageViewer.addObject(rect);
                this._overlayObjects.push({ rect, symId: symKey, inCurrent: true });
            } else if (inCurrent) {
                // Current cluster symbol: visible highlight
                const rect = new fabric.Rect({
                    ...pos,
                    fill: `${baseColor}33`, stroke: baseColor, strokeWidth: 2,
                    opacity: 1, selectable: false, evented: false,
                });
                ImageViewer.addObject(rect);
                this._overlayObjects.push({ rect, symId: symKey, inCurrent: true });
            } else {
                // Other cluster: dimmed
                const rect = new fabric.Rect({
                    ...pos,
                    fill: 'transparent', stroke: baseColor, strokeWidth: 1,
                    opacity: 0.15, selectable: false, evented: false,
                });
                ImageViewer.addObject(rect);
                this._overlayObjects.push({ rect, symId: symKey, inCurrent: false });
            }
        }

        ImageViewer.render();
    },

    showNoData() {
        document.getElementById('sidebarTitle').textContent = 'Classification';
        document.getElementById('sidebarContent').innerHTML =
            '<div style="padding:16px;color:#888;text-align:center">No classification data available. Run symbol detection and classification first.</div>';
    },

    updateSidebar() {
        const cluster = this.clusters[this.currentClusterIdx];
        document.getElementById('sidebarTitle').textContent = 'Classification';
        document.getElementById('sidebarCount').textContent = `${this.clusters.length} clusters`;

        let html = '';

        // Cluster navigation
        html += '<div style="padding:8px;border-bottom:1px solid #2a2a4a">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
        html += `<button class="btn" onclick="ClassifierEditor.prevCluster()" ${this.currentClusterIdx === 0 ? 'disabled' : ''} style="padding:4px 10px">&#9664;</button>`;
        html += `<span style="flex:1;text-align:center;font-size:13px">Cluster #${cluster ? cluster.id : '-'} (${this.currentClusterIdx + 1}/${this.clusters.length})</span>`;
        html += `<button class="btn" onclick="ClassifierEditor.nextCluster()" ${this.currentClusterIdx >= this.clusters.length - 1 ? 'disabled' : ''} style="padding:4px 10px">&#9654;</button>`;
        html += '</div>';

        if (cluster) {
            html += '<div style="display:flex;align-items:center;gap:6px">';
            html += '<label style="color:#888;font-size:12px;white-space:nowrap">Label:</label>';
            html += `<input class="filter-input" style="margin-bottom:0" type="text" id="clusterLabelInput" value="${cluster.label || ''}" onchange="ClassifierEditor.setLabel(this.value)" placeholder="Enter label...">`;
            html += '</div>';
        }
        html += '</div>';

        // Patch grid for current cluster
        if (cluster) {
            const symIds = cluster.symbol_ids || [];
            html += `<div style="padding:8px;font-size:12px;color:#888;border-bottom:1px solid #2a2a4a">${symIds.length} symbols in this cluster</div>`;
            html += '<div class="patch-grid" style="padding:8px">';
            for (const sid of symIds) {
                const sel = this.selectedSymbolIds.has(sid) ? 'selected' : '';
                html += `<div class="patch-item ${sel}" onclick="ClassifierEditor.toggleSymbol(${sid})">
                    <img src="${API.sessionUrl(`/masks/${sid}/patch`)}" alt="Symbol ${sid}">
                    <div class="patch-id">#${sid}</div>
                </div>`;
            }
            html += '</div>';

            // Actions for selected symbols
            if (this.selectedSymbolIds.size > 0) {
                html += '<div style="padding:8px;border-top:1px solid #2a2a4a">';
                html += `<div style="font-size:12px;color:#4fc3f7;margin-bottom:6px">${this.selectedSymbolIds.size} selected</div>`;
                html += '<div style="display:flex;flex-wrap:wrap;gap:4px">';
                html += '<button class="btn" onclick="ClassifierEditor.moveToCluster()" style="font-size:12px;padding:4px 8px">Move to Cluster</button>';
                html += '<button class="btn" onclick="ClassifierEditor.newCluster()" style="font-size:12px;padding:4px 8px">New Cluster</button>';
                html += '<button class="btn danger" onclick="ClassifierEditor.deleteSelectedSymbols()" style="font-size:12px;padding:4px 8px">Delete</button>';
                html += '</div></div>';
            }
        }

        // Cluster list
        html += '<div style="padding:8px 8px 4px;font-size:11px;color:#666;border-top:1px solid #2a2a4a;margin-top:4px">ALL CLUSTERS</div>';
        for (let i = 0; i < this.clusters.length; i++) {
            const c = this.clusters[i];
            const sel = i === this.currentClusterIdx ? 'selected' : '';
            html += `<div class="list-item ${sel}" onclick="ClassifierEditor.goToCluster(${i})">
                <span class="label">#${c.id} ${c.label || 'Unlabeled'}</span>
                <span class="score">${(c.symbol_ids || []).length}</span>
            </div>`;
        }

        document.getElementById('sidebarContent').innerHTML = html;
    },

    toggleSymbol(id) {
        if (this.selectedSymbolIds.has(id)) this.selectedSymbolIds.delete(id);
        else this.selectedSymbolIds.add(id);
        this.renderOverlay();
        this.updateSidebar();
    },

    prevCluster() {
        if (this.currentClusterIdx > 0) {
            this.currentClusterIdx--;
            this.selectedSymbolIds.clear();
            this.renderOverlay();
            this.updateSidebar();
            this._zoomToCluster();
        }
    },

    nextCluster() {
        if (this.currentClusterIdx < this.clusters.length - 1) {
            this.currentClusterIdx++;
            this.selectedSymbolIds.clear();
            this.renderOverlay();
            this.updateSidebar();
            this._zoomToCluster();
        }
    },

    goToCluster(idx) {
        this.currentClusterIdx = idx;
        this.selectedSymbolIds.clear();
        this.renderOverlay();
        this.updateSidebar();
    },

    _zoomToCluster() {
        // Optionally zoom to fit the current cluster's bounding box
        const cluster = this.clusters[this.currentClusterIdx];
        if (!cluster) return;
        const symIds = new Set(cluster.symbol_ids || []);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const sym of this.symbols) {
            if (!symIds.has(sym.id) || !sym.bbox) continue;
            const [x1, y1, x2, y2] = sym.bbox;
            minX = Math.min(minX, x1);
            minY = Math.min(minY, y1);
            maxX = Math.max(maxX, x2);
            maxY = Math.max(maxY, y2);
        }
        if (minX === Infinity) return;
        // Don't auto-zoom, just fit to screen - user can zoom manually
    },

    _pointInSym(px, py, sym) {
        const [x1, y1, x2, y2] = sym.bbox;
        const angle = sym.angle || (sym.rotated_bbox && sym.rotated_bbox.angle) || 0;
        if (angle === 0) {
            return px >= x1 && px <= x2 && py >= y1 && py <= y2;
        }
        const rb = sym.rotated_bbox;
        const cx = rb ? rb.cx : (x1 + x2) / 2;
        const cy = rb ? rb.cy : (y1 + y2) / 2;
        const hw = (rb ? rb.width : (x2 - x1)) / 2;
        const hh = (rb ? rb.height : (y2 - y1)) / 2;
        const rad = -angle * Math.PI / 180;
        const dx = px - cx, dy = py - cy;
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        return lx >= -hw && lx <= hw && ly >= -hh && ly <= hh;
    },

    onClick(pointer) {
        // Click on canvas to select/deselect a symbol in current cluster
        const cluster = this.clusters[this.currentClusterIdx];
        if (!cluster) return;
        const currentSymIds = new Set(cluster.symbol_ids || []);

        for (const sym of this.symbols) {
            const symKey = sym.mask_id !== undefined ? sym.mask_id : sym.id;
            if (!currentSymIds.has(symKey) || !sym.bbox) continue;
            if (this._pointInSym(pointer.x, pointer.y, sym)) {
                this.toggleSymbol(symKey);
                return;
            }
        }
    },

    async setLabel(label) {
        const cluster = this.clusters[this.currentClusterIdx];
        if (!cluster) return;
        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });
        await API.put(API.sessionUrl(`/classification/clusters/${cluster.id}/label`), { label });
        cluster.label = label;
        this.updateSidebar();
        App.setStatus(`Labeled cluster as "${label}"`);
    },

    async moveToCluster() {
        if (this.selectedSymbolIds.size === 0) return;
        const clusterList = this.clusters.map(c => `  ${c.id}: ${c.label || 'Unlabeled'}`).join('\n');
        const input = prompt(`Enter target cluster ID:\n${clusterList}`);
        if (input === null) return;
        const targetId = parseInt(input);
        const target = this.clusters.find(c => c.id === targetId);
        if (!target) {
            App.showToast(`Cluster ID ${targetId} not found`, 'error');
            return;
        }
        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });
        await API.post(API.sessionUrl('/classification/move'), {
            symbol_ids: [...this.selectedSymbolIds],
            target_cluster_id: target.id,
            target_label: target.label,
        });
        this.selectedSymbolIds.clear();
        await this._reload(true);
        App.setStatus('Moved symbols');
    },

    async newCluster() {
        if (this.selectedSymbolIds.size === 0) return;
        const label = prompt('Label for new cluster:');
        if (label === null) return;
        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });
        await API.post(API.sessionUrl('/classification/move'), {
            symbol_ids: [...this.selectedSymbolIds],
            target_cluster_id: null,
            target_label: label,
        });
        this.selectedSymbolIds.clear();
        await this._reload(true);
        App.setStatus('Created new cluster');
    },

    async deleteSelectedSymbols() {
        if (this.selectedSymbolIds.size === 0) return;
        const count = this.selectedSymbolIds.size;
        if (!confirm(`Delete ${count} selected symbol(s)?\n\nThis will remove them from both classification and symbol detection results.`)) return;

        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });
        await API.post(API.sessionUrl('/classification/delete-symbols'), {
            symbol_ids: [...this.selectedSymbolIds],
        });
        this.selectedSymbolIds.clear();
        await this._reload(true);
        App.setStatus(`Deleted ${count} symbol(s)`);
    },

    async discardCluster() {
        const cluster = this.clusters[this.currentClusterIdx];
        if (!cluster) return;
        const count = (cluster.symbol_ids || []).length;
        if (!confirm(`Discard cluster #${cluster.id} "${cluster.label || 'Unlabeled'}" (${count} symbols)?\n\nThis will remove these symbols from both classification and symbol detection results.`)) return;

        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });
        await API.post(API.sessionUrl(`/classification/clusters/${cluster.id}/discard`));
        if (this.currentClusterIdx >= this.clusters.length - 1 && this.currentClusterIdx > 0) {
            this.currentClusterIdx--;
        }
        await this._reload(true);
        App.setStatus(`Discarded cluster #${cluster.id}`);
    },

    async autoLabel() {
        try {
            App.showCenterLoading('Loading symbol sets...');
            const setsData = await API.get(API.sessionUrl('/classification/symbol-sets'));
            const sets = setsData.sets || [];

            let symbolSet = null;
            if (sets.length === 0) {
                App.hideCenterLoading();
                App.showToast('No reference symbol sets found in symbols/ directory', 'error');
                return;
            } else if (sets.length === 1) {
                symbolSet = sets[0].name;
            } else {
                App.hideCenterLoading();
                const list = sets.map(s => `  ${s.name} (${s.count} symbols)`).join('\n');
                const input = prompt(`Choose a symbol set (or leave empty for all):\n${list}`);
                if (input === null) return;
                symbolSet = input.trim() || null;
                App.showCenterLoading('Running CLIP embedding matching...');
            }

            App.updateCenterLoading('Running CLIP embedding matching...');
            const result = await API.post(API.sessionUrl('/classification/auto-label'), {
                symbol_set: symbolSet,
                threshold: 0.65,
            });

            App.hideCenterLoading();
            await this._reload(true);
            App.showToast(
                `Auto-labeled ${result.labeled_clusters}/${result.total_clusters} clusters`,
                result.labeled_clusters > 0 ? 'success' : 'error'
            );
            App.setStatus('Auto-label complete');
        } catch (e) {
            App.hideCenterLoading();
            App.showToast('Auto-label failed: ' + e.message, 'error');
            App.setStatus('Ready');
        }
    },

    getToolbar() {
        return `
            <button class="btn" onclick="ClassifierEditor.prevCluster()">&#9664; Prev Cluster</button>
            <button class="btn" onclick="ClassifierEditor.nextCluster()">Next Cluster &#9654;</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="ClassifierEditor.showMergeDialog()">Merge Clusters</button>
            <button class="btn primary" onclick="ClassifierEditor.autoLabel()">Auto Label</button>
            <div class="btn-sep"></div>
            <button class="btn danger" onclick="ClassifierEditor.discardCluster()">Discard Cluster</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="ClassifierEditor.undo()">Undo</button>
            <button class="btn" onclick="ClassifierEditor.redo()">Redo</button>
            <div class="btn-sep"></div>
            <button class="btn" onclick="ClassifierEditor.load()">Refresh</button>
            <button class="btn" onclick="ImageViewer.fitToScreen()">Fit View</button>
        `;
    },

    showMergeDialog() {
        if (this.clusters.length < 2) {
            App.showToast('Need at least 2 clusters to merge', 'error');
            return;
        }

        // Build modal with checkboxes for each cluster
        let clusterListHtml = '';
        for (const c of this.clusters) {
            const count = (c.symbol_ids || []).length;
            clusterListHtml += `
                <label class="merge-cluster-item">
                    <input type="checkbox" value="${c.id}" class="merge-cluster-cb">
                    <span class="merge-cluster-label">#${c.id} — ${c.label || 'Unlabeled'} (${count} symbols)</span>
                </label>
            `;
        }

        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop';
        backdrop.id = 'mergeModal';
        backdrop.innerHTML = `
            <div class="modal" style="max-width:450px;">
                <h3>Merge Clusters</h3>
                <p style="color:#888;font-size:13px;margin-bottom:12px">Select 2 or more clusters to merge into one.</p>
                <div class="merge-cluster-list">${clusterListHtml}</div>
                <div style="margin-top:12px">
                    <label style="color:#888;font-size:12px">Label for merged cluster:</label>
                    <input type="text" id="mergeLabelInput" placeholder="Leave empty to use target cluster label" style="width:100%;padding:8px 12px;background:#0f1529;border:1px solid #3a3a5c;color:#e0e0e0;border-radius:6px;font-size:14px;margin-top:4px;">
                </div>
                <div class="modal-actions" style="margin-top:16px">
                    <button class="btn" onclick="ClassifierEditor.closeMergeDialog()">Cancel</button>
                    <button class="btn primary" onclick="ClassifierEditor.executeMerge()">Merge</button>
                </div>
            </div>
        `;
        document.body.appendChild(backdrop);
    },

    closeMergeDialog() {
        const modal = document.getElementById('mergeModal');
        if (modal) modal.remove();
    },

    async executeMerge() {
        const checkboxes = document.querySelectorAll('.merge-cluster-cb:checked');
        const selectedIds = Array.from(checkboxes).map(cb => parseInt(cb.value));

        if (selectedIds.length < 2) {
            App.showToast('Select at least 2 clusters to merge', 'error');
            return;
        }

        const labelInput = document.getElementById('mergeLabelInput');
        const label = labelInput ? labelInput.value.trim() : '';

        // Use the first selected cluster as the target
        const targetId = selectedIds[0];

        this.closeMergeDialog();
        this.undoMgr.snapshot({ clusters: this.clusters, symbols: this.symbols });

        try {
            const result = await API.post(API.sessionUrl('/classification/merge'), {
                source_cluster_ids: selectedIds,
                target_cluster_id: targetId,
                target_label: label,
            });

            await this._reload(true);
            App.showToast(
                `Merged ${selectedIds.length} clusters into #${targetId} "${result.target_label}" (${result.merged_symbols} symbols)`,
                'success'
            );
        } catch (e) {
            App.showToast('Merge failed: ' + e.message, 'error');
        }
    },

    async undo() {
        const prev = this.undoMgr.undo({ clusters: this.clusters, symbols: this.symbols });
        if (!prev) { App.setStatus('Nothing to undo'); return; }
        this.clusters = prev.clusters;
        this.symbols = prev.symbols;
        await API.put(API.sessionUrl('/classification/bulk'), {
            clusters: this.clusters,
            symbols: this.symbols,
        });
        this.selectedSymbolIds.clear();
        if (this.currentClusterIdx >= this.clusters.length) {
            this.currentClusterIdx = Math.max(0, this.clusters.length - 1);
        }
        this.renderOverlay();
        this.updateSidebar();
        App.setStatus('Undo');
    },

    async redo() {
        const next = this.undoMgr.redo({ clusters: this.clusters, symbols: this.symbols });
        if (!next) { App.setStatus('Nothing to redo'); return; }
        this.clusters = next.clusters;
        this.symbols = next.symbols;
        await API.put(API.sessionUrl('/classification/bulk'), {
            clusters: this.clusters,
            symbols: this.symbols,
        });
        this.selectedSymbolIds.clear();
        if (this.currentClusterIdx >= this.clusters.length) {
            this.currentClusterIdx = Math.max(0, this.clusters.length - 1);
        }
        this.renderOverlay();
        this.updateSidebar();
        App.setStatus('Redo');
    },

    deactivate() {
        // Remove the old overlay if it still exists (from before this refactor)
        const overlay = document.getElementById('classifierOverlay');
        if (overlay) overlay.remove();
        this._overlayObjects = [];
        this.closeMergeDialog();
    },
};
