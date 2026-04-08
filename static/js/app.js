/**
 * Main Application Controller
 * Manages session state, tab switching, pipeline execution, and global interactions.
 */
const App = {
    currentTab: null,
    sessionStatus: null,
    shiftKey: false,
    taskPollers: {},
    // Scale factor: text/line coords are in resized space, image is in original space.
    // coordScale = original_width / resized_width. Multiply resized coords by this to get image coords.
    coordScale: 1.0,

    async init() {
        // Track modifier keys
        document.addEventListener('keydown', e => {
            this.shiftKey = e.shiftKey;
            this._handleKeyboard(e);
        });
        document.addEventListener('keyup', e => { this.shiftKey = e.shiftKey; });

        // Tab click handlers
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
        });

        // Initialize image viewer
        ImageViewer.init();

        // Set up canvas click routing
        ImageViewer.onClickCallback = (pointer, event) => this._routeClick(pointer, event);
        ImageViewer.onMouseMoveCallback = (pointer) => {
            document.getElementById('statusCoords').textContent =
                `x: ${Math.round(pointer.x)}, y: ${Math.round(pointer.y)}`;
        };

        // Canvas mouse events for draw modes
        ImageViewer.canvas.on('mouse:down', opt => {
            if (opt.e.button !== 0 || opt.e.altKey) return;
            const pointer = ImageViewer.canvas.getPointer(opt.e);
            if (this.currentTab === 'masks' && MaskEditor.drawMode) {
                MaskEditor.onMouseDown(pointer);
            }
            if (this.currentTab === 'text' && TextEditor.drawMode) {
                TextEditor.onMouseDown(pointer);
            }
            if (this.currentTab === 'lines' && LineEditor.drawMode) {
                LineEditor.onMouseDown(pointer);
            }
        });
        ImageViewer.canvas.on('mouse:move', opt => {
            const pointer = ImageViewer.canvas.getPointer(opt.e);
            if (this.currentTab === 'masks' && MaskEditor.drawMode) {
                MaskEditor.onMouseMove(pointer);
            }
            if (this.currentTab === 'text' && TextEditor.drawMode) {
                TextEditor.onMouseMove(pointer);
            }
        });
        ImageViewer.canvas.on('mouse:up', opt => {
            if (opt.e.button !== 0 || opt.e.altKey) return;
            const pointer = ImageViewer.canvas.getPointer(opt.e);
            if (this.currentTab === 'masks' && MaskEditor.drawMode) {
                MaskEditor.onMouseUp(pointer);
            }
            if (this.currentTab === 'text' && TextEditor.drawMode) {
                TextEditor.onMouseUp(pointer);
            }
        });

        // Load session status
        await this.loadSessionStatus();

        // Load image
        try {
            await ImageViewer.loadImage(API.sessionUrl('/image'));
        } catch (e) {
            this.setStatus('No image available');
        }

        // Compute coordinate scale: text/line data is in resized coords, image is original
        await this._computeCoordScale();

        // Determine which tab to show first
        if (this.sessionStatus && this.sessionStatus.steps_complete) {
            const steps = this.sessionStatus.steps_complete;
            if (steps.symbol_detection) {
                this.switchTab('masks');
            } else {
                this.switchTab('pipeline');
            }
        } else {
            this.switchTab('pipeline');
        }
    },

    async loadSessionStatus() {
        try {
            this.sessionStatus = await API.get(API.sessionUrl('/status'));
            document.getElementById('sessionInfo').textContent =
                `${this.sessionStatus.image_name || 'No image'} | Session: ${SESSION_ID}`;
            this._updateTabStates();
        } catch (e) {
            this.setStatus('Error loading session');
        }
    },

    async _computeCoordScale() {
        // Text/line coordinates are in the resized image space (target_width, e.g. 7168).
        // The canvas shows the original image. We need to scale overlay coords.
        try {
            const linesData = await API.get(API.sessionUrl('/lines'));
            if (ImageViewer.imageWidth > 0) {
                if (linesData.resized_shape) {
                    const resizedWidth = linesData.resized_shape[1];  // [height, width]
                    this.coordScale = ImageViewer.imageWidth / resizedWidth;
                } else if (linesData.target_width) {
                    this.coordScale = ImageViewer.imageWidth / linesData.target_width;
                } else if (linesData.scale) {
                    // scale = target_width / original_width, so coordScale = 1/scale
                    this.coordScale = 1.0 / linesData.scale;
                }
            }
        } catch (e) {
            // No lines data yet
        }
        console.log('Coordinate scale factor:', this.coordScale);
    },

    _updateTabStates() {
        if (!this.sessionStatus) return;
        const steps = this.sessionStatus.steps_complete || {};

        // Enable/disable tabs based on available data
        document.querySelectorAll('.tab').forEach(tab => {
            const name = tab.dataset.tab;
            tab.classList.remove('disabled');

            if (name === 'masks' && !steps.symbol_detection) tab.classList.add('disabled');
            if (name === 'classification' && !steps.classification) tab.classList.add('disabled');
            if (name === 'text' && !steps.text_detection) tab.classList.add('disabled');
            if (name === 'lines' && !steps.line_detection) tab.classList.add('disabled');
            if (name === 'graph' && !steps.digitization) tab.classList.add('disabled');
        });
    },

    async switchTab(tabName) {
        // Deactivate current editor
        if (this.currentTab === 'masks') MaskEditor.deactivate();
        if (this.currentTab === 'classification') ClassifierEditor.deactivate();
        if (this.currentTab === 'text') TextEditor.deactivate();
        if (this.currentTab === 'lines') LineEditor.deactivate();
        if (this.currentTab === 'graph') GraphViewer.destroy();

        this.currentTab = tabName;

        // Update tab bar
        document.querySelectorAll('.tab').forEach(t => {
            t.classList.toggle('active', t.dataset.tab === tabName);
        });

        const toolbar = document.getElementById('editorToolbar');
        const sidebar = document.getElementById('sidebar');
        const canvasContainer = document.getElementById('canvasContainer');

        // Show/hide canvas and sidebar based on tab
        if (tabName === 'pipeline') {
            sidebar.style.display = 'none';
            toolbar.innerHTML = '';
        } else if (tabName === 'graph') {
            sidebar.style.display = 'none';
        } else {
            sidebar.style.display = '';
        }

        ImageViewer.clearOverlays();

        // Clean up overlays from other tabs
        ['pipelineOverlay', 'graphOverlay', 'classifierOverlay'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        switch (tabName) {
            case 'pipeline':
                toolbar.innerHTML = '';
                this._showPipelinePanel();
                break;
            case 'masks':
                toolbar.innerHTML = MaskEditor.getToolbar();
                await MaskEditor.load();
                break;
            case 'classification':
                toolbar.innerHTML = ClassifierEditor.getToolbar();
                await ClassifierEditor.load();
                break;
            case 'text':
                toolbar.innerHTML = TextEditor.getToolbar();
                await TextEditor.load();
                break;
            case 'lines':
                toolbar.innerHTML = LineEditor.getToolbar();
                await LineEditor.load();
                break;
            case 'graph':
                toolbar.innerHTML = '';
                await this._showGraphPanel();
                break;
        }
    },

    _routeClick(pointer, event) {
        switch (this.currentTab) {
            case 'masks': MaskEditor.onClick(pointer); break;
            case 'classification': ClassifierEditor.onClick(pointer); break;
            case 'text': TextEditor.onClick(pointer); break;
            case 'lines': LineEditor.onClick(pointer); break;
        }
    },

    _handleKeyboard(e) {
        // Global shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.key === 'z') {
                e.preventDefault();
                if (this.currentTab === 'text') TextEditor.undo();
                else if (this.currentTab === 'lines') LineEditor.undo();
                else if (this.currentTab === 'masks') MaskEditor.undo();
            }
            if (e.key === 'y') {
                e.preventDefault();
                if (this.currentTab === 'text') TextEditor.redo();
                else if (this.currentTab === 'lines') LineEditor.redo();
                else if (this.currentTab === 'masks') MaskEditor.redo();
            }
        }

        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            if (this.currentTab === 'text') TextEditor.deleteSelected();
            else if (this.currentTab === 'lines') LineEditor.deleteSelected();
            else if (this.currentTab === 'masks') MaskEditor.deleteSelected();
        }

        if (e.key === 'e' || e.key === 'E') {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            if (this.currentTab === 'text') TextEditor.editTextDialog();
        }

        if (e.key === 'c' && !e.ctrlKey && !e.metaKey) {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            if (this.currentTab === 'text') TextEditor.combineSelected();
        }

        // Zoom shortcuts
        if ((e.key === '=' || e.key === '+') && !e.ctrlKey && !e.metaKey) {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            ImageViewer.zoomIn();
        }
        if (e.key === '-' && !e.ctrlKey && !e.metaKey) {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            ImageViewer.zoomOut();
        }
        if (e.key === '0' && !e.ctrlKey && !e.metaKey) {
            if (document.activeElement && (document.activeElement.tagName === 'INPUT' ||
                document.activeElement.tagName === 'TEXTAREA')) return;
            ImageViewer.fitToScreen();
        }

        if (e.key === 'Escape') {
            if (this.currentTab === 'text') TextEditor.clearSelection();
            else if (this.currentTab === 'masks') MaskEditor.clearSelection();
            else if (this.currentTab === 'lines') {
                LineEditor.selectedType = null;
                LineEditor.selectedIdx = null;
                LineEditor.render();
                LineEditor.updateSidebar();
            }
        }
    },

    // Pipeline Panel
    _showPipelinePanel() {
        const steps = (this.sessionStatus && this.sessionStatus.steps_complete) || {};
        const canvasContainer = document.getElementById('canvasContainer');

        let overlay = document.getElementById('pipelineOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'pipelineOverlay';
            overlay.style.cssText = 'position:absolute;inset:0;background:#111;overflow-y:auto;z-index:50;';
            canvasContainer.appendChild(overlay);
        }

        overlay.innerHTML = `
            <div class="pipeline-panel">
                <h2 style="color:#4fc3f7;margin-bottom:8px">Processing Pipeline</h2>
                <p style="color:#888;margin-bottom:24px">Run each step to process the P&ID image, or skip if using uploaded results.</p>

                <div class="pipeline-steps">
                    <div class="pipeline-step ${steps.symbol_detection ? 'complete' : ''}" id="pStep1">
                        <div class="step-num">1</div>
                        <div class="step-name">Symbol Detection</div>
                        <div class="step-status">${steps.symbol_detection ? 'Complete' : 'Pending'}</div>
                        <button class="btn primary" onclick="App.runDetection()" ${steps.symbol_detection ? 'disabled' : ''}>
                            ${steps.symbol_detection ? 'Done' : 'Run'}
                        </button>
                    </div>

                    <div class="pipeline-step ${steps.classification ? 'complete' : ''}" id="pStep2">
                        <div class="step-num">2</div>
                        <div class="step-name">Classification</div>
                        <div class="step-status">${steps.classification ? 'Complete' : 'Pending'}</div>
                        <button class="btn primary" onclick="App.runClassification()" ${!steps.symbol_detection || steps.classification ? 'disabled' : ''}>
                            ${steps.classification ? 'Done' : 'Run'}
                        </button>
                    </div>

                    <div class="pipeline-step ${steps.text_detection && steps.line_detection ? 'complete' : ''}" id="pStep3">
                        <div class="step-num">3</div>
                        <div class="step-name">Text & Line Detection</div>
                        <div class="step-status">${steps.text_detection ? 'Complete' : 'Pending'}</div>
                        <button class="btn primary" onclick="App.runTextLines()" ${steps.text_detection ? 'disabled' : ''}>
                            ${steps.text_detection ? 'Done' : 'Run'}
                        </button>
                    </div>

                    <div class="pipeline-step ${steps.digitization ? 'complete' : ''}" id="pStep4">
                        <div class="step-num">4</div>
                        <div class="step-name">Digitization</div>
                        <div class="step-status">${steps.digitization ? 'Complete' : 'Pending'}</div>
                        <button class="btn primary" onclick="App.runDigitize()"
                            ${!(steps.symbol_detection && steps.text_detection) || steps.digitization ? 'disabled' : ''}>
                            ${steps.digitization ? 'Done' : 'Run'}
                        </button>
                    </div>
                </div>

                <div style="margin-top:24px">
                    <p style="color:#666;font-size:13px">
                        After running the pipeline, switch to the editor tabs to review and edit results.
                    </p>
                </div>
            </div>
        `;
    },

    _removePipelineOverlay() {
        const overlay = document.getElementById('pipelineOverlay');
        if (overlay) overlay.remove();
    },

    async runDetection() {
        const step = document.getElementById('pStep1');
        step.classList.add('running');
        step.querySelector('.step-status').textContent = 'Running...';
        step.querySelector('button').disabled = true;

        try {
            const { task_id } = await API.post(API.sessionUrl('/run/detect'), {
                detector: 'yolo'
            });

            await API.pollTask(task_id, (status) => {
                step.querySelector('.step-status').textContent = status.progress || 'Running...';
            });

            step.classList.remove('running');
            step.classList.add('complete');
            step.querySelector('.step-status').textContent = 'Complete';
            await this.loadSessionStatus();
            this._showPipelinePanel();
            this.showToast('Symbol detection complete!', 'success');
        } catch (e) {
            step.classList.remove('running');
            step.querySelector('.step-status').textContent = 'Error: ' + e.message;
            step.querySelector('button').disabled = false;
            this.showToast('Detection failed: ' + e.message, 'error');
        }
    },

    async runClassification() {
        const step = document.getElementById('pStep2');
        step.classList.add('running');
        step.querySelector('.step-status').textContent = 'Running...';
        step.querySelector('button').disabled = true;

        try {
            const { task_id } = await API.post(API.sessionUrl('/run/classify'));
            await API.pollTask(task_id, (status) => {
                step.querySelector('.step-status').textContent = status.progress || 'Running...';
            });

            step.classList.remove('running');
            step.classList.add('complete');
            step.querySelector('.step-status').textContent = 'Complete';
            await this.loadSessionStatus();
            this._showPipelinePanel();
            this.showToast('Classification complete!', 'success');
        } catch (e) {
            step.classList.remove('running');
            step.querySelector('.step-status').textContent = 'Error: ' + e.message;
            step.querySelector('button').disabled = false;
            this.showToast('Classification failed: ' + e.message, 'error');
        }
    },

    async runTextLines() {
        const step = document.getElementById('pStep3');
        step.classList.add('running');
        step.querySelector('.step-status').textContent = 'Running...';
        step.querySelector('button').disabled = true;

        try {
            const { task_id } = await API.post(API.sessionUrl('/run/text-lines'));
            await API.pollTask(task_id, (status) => {
                step.querySelector('.step-status').textContent = status.progress || 'Running...';
            });

            step.classList.remove('running');
            step.classList.add('complete');
            step.querySelector('.step-status').textContent = 'Complete';
            await this.loadSessionStatus();
            this._showPipelinePanel();
            this.showToast('Text & line detection complete!', 'success');
        } catch (e) {
            step.classList.remove('running');
            step.querySelector('.step-status').textContent = 'Error: ' + e.message;
            step.querySelector('button').disabled = false;
            this.showToast('Detection failed: ' + e.message, 'error');
        }
    },

    async runDigitize() {
        const step = document.getElementById('pStep4');
        if (step) {
            step.classList.add('running');
            step.querySelector('.step-status').textContent = 'Running...';
            step.querySelector('button').disabled = true;
        }

        this.setStatus('Running digitization...');

        try {
            const result = await API.post(API.sessionUrl('/run/digitize'));
            if (step) {
                step.classList.remove('running');
                step.classList.add('complete');
                step.querySelector('.step-status').textContent = 'Complete';
            }
            await this.loadSessionStatus();
            this.showToast(`Digitization complete: ${result.nodes} nodes, ${result.links} links`, 'success');

            // If on graph tab, reload the graph view
            if (this.currentTab === 'graph') {
                await this._showGraphPanel();
            } else {
                this._showPipelinePanel();
            }
        } catch (e) {
            if (step) {
                step.classList.remove('running');
                step.querySelector('.step-status').textContent = 'Error: ' + e.message;
                step.querySelector('button').disabled = false;
            }
            this.showToast('Digitization failed: ' + e.message, 'error');
        }
    },

    // Graph Panel
    async _showGraphPanel() {
        try {
            const graph = await API.get(API.sessionUrl('/export/graph'));
            await GraphViewer.load(graph);
            document.getElementById('editorToolbar').innerHTML = GraphViewer.getToolbar();
        } catch (e) {
            const canvasContainer = document.getElementById('canvasContainer');
            let overlay = document.getElementById('graphOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.id = 'graphOverlay';
                overlay.style.cssText = 'position:absolute;inset:0;background:#111;overflow-y:auto;z-index:50;';
                canvasContainer.appendChild(overlay);
            }
            overlay.innerHTML = `
                <div class="pipeline-panel">
                    <p style="color:#888">No graph data available.</p>
                    <button class="btn primary" style="margin-top:16px" onclick="App.switchTab('pipeline')">Go to Pipeline</button>
                </div>
            `;
        }
    },

    // Global actions
    async saveAll() {
        await API.post(API.sessionUrl('/masks/save'));
        await API.post(API.sessionUrl('/text/save'));
        await API.post(API.sessionUrl('/lines/save'));
        await API.post(API.sessionUrl('/classification/save'));
        this.showToast('All data saved', 'success');
    },

    exportZip() {
        window.open(API.sessionUrl('/export/zip'), '_blank');
    },

    // UI helpers
    setStatus(msg) {
        document.getElementById('statusMsg').textContent = msg;
    },

    showToast(msg, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = msg;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    },

    showCenterLoading(msg) {
        this.hideCenterLoading();
        const overlay = document.createElement('div');
        overlay.id = 'centerLoadingOverlay';
        overlay.innerHTML = `<div class="center-loading-box"><div class="center-loading-spinner"></div><div class="center-loading-msg">${msg}</div></div>`;
        document.body.appendChild(overlay);
    },

    updateCenterLoading(msg) {
        const el = document.querySelector('#centerLoadingOverlay .center-loading-msg');
        if (el) el.textContent = msg;
    },

    hideCenterLoading() {
        const el = document.getElementById('centerLoadingOverlay');
        if (el) el.remove();
    },
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => App.init());
