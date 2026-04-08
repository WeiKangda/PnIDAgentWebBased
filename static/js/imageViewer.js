/**
 * Image Viewer - Fabric.js canvas with pan/zoom for large P&ID images
 */
const ImageViewer = {
    canvas: null,
    bgImage: null,
    imageWidth: 0,
    imageHeight: 0,
    isPanning: false,
    lastPosX: 0,
    lastPosY: 0,
    onClickCallback: null,
    onMouseMoveCallback: null,

    init() {
        const container = document.getElementById('canvasContainer');
        const w = container.clientWidth;
        const h = container.clientHeight;

        this.canvas = new fabric.Canvas('mainCanvas', {
            width: w,
            height: h,
            selection: false,
            renderOnAddRemove: false,
        });

        // Zoom with mouse wheel
        this.canvas.on('mouse:wheel', (opt) => {
            const e = opt.e;
            e.preventDefault();
            e.stopPropagation();
            const delta = e.deltaY;
            let zoom = this.canvas.getZoom();
            // Use a more responsive zoom factor
            const zoomFactor = delta > 0 ? 0.9 : 1.1;
            zoom *= zoomFactor;
            zoom = Math.min(Math.max(0.05, zoom), 20);
            this.canvas.zoomToPoint({ x: e.offsetX, y: e.offsetY }, zoom);
            this.canvas.requestRenderAll();
            this._updateZoomDisplay();
        });

        // Pan with middle mouse or alt+drag
        this.canvas.on('mouse:down', (opt) => {
            const e = opt.e;
            if (e.button === 1 || e.altKey) {
                this.isPanning = true;
                this.lastPosX = e.clientX;
                this.lastPosY = e.clientY;
                this.canvas.selection = false;
                e.preventDefault();
            }
        });

        this.canvas.on('mouse:move', (opt) => {
            if (this.isPanning) {
                const e = opt.e;
                const vpt = this.canvas.viewportTransform;
                vpt[4] += e.clientX - this.lastPosX;
                vpt[5] += e.clientY - this.lastPosY;
                this.lastPosX = e.clientX;
                this.lastPosY = e.clientY;
                this.canvas.requestRenderAll();
            }
            // Track coordinates
            if (this.onMouseMoveCallback) {
                const pointer = this.canvas.getPointer(opt.e);
                this.onMouseMoveCallback(pointer);
            }
        });

        this.canvas.on('mouse:up', (opt) => {
            this.isPanning = false;
        });

        // Click handling (for editors)
        this.canvas.on('mouse:down', (opt) => {
            if (opt.e.button === 0 && !opt.e.altKey && this.onClickCallback) {
                const pointer = this.canvas.getPointer(opt.e);
                // Small delay to distinguish click from pan
                this._clickPointer = pointer;
                this._clickTime = Date.now();
            }
        });

        this.canvas.on('mouse:up', (opt) => {
            if (this._clickPointer && Date.now() - this._clickTime < 300) {
                const upPointer = this.canvas.getPointer(opt.e);
                const dx = upPointer.x - this._clickPointer.x;
                const dy = upPointer.y - this._clickPointer.y;
                if (Math.abs(dx) < 5 && Math.abs(dy) < 5) {
                    if (this.onClickCallback) {
                        this.onClickCallback(this._clickPointer, opt.e);
                    }
                }
            }
            this._clickPointer = null;
        });

        // Resize handler
        window.addEventListener('resize', () => this.resize());
    },

    resize() {
        const container = document.getElementById('canvasContainer');
        this.canvas.setWidth(container.clientWidth);
        this.canvas.setHeight(container.clientHeight);
        this.canvas.requestRenderAll();
    },

    async loadImage(url) {
        return new Promise((resolve, reject) => {
            fabric.Image.fromURL(url, (img) => {
                if (!img) { reject(new Error('Failed to load image')); return; }
                this.bgImage = img;
                this.imageWidth = img.width;
                this.imageHeight = img.height;

                img.set({
                    selectable: false,
                    evented: false,
                    hoverCursor: 'default',
                });

                this.canvas.clear();
                this.canvas.add(img);
                this.canvas.sendToBack(img);

                // Fit image to canvas
                this.fitToScreen();
                resolve();
            }, { crossOrigin: 'anonymous' });
        });
    },

    fitToScreen() {
        if (!this.bgImage) return;
        const cw = this.canvas.getWidth();
        const ch = this.canvas.getHeight();
        const zoom = Math.min(cw / this.imageWidth, ch / this.imageHeight) * 0.95;
        this._baseZoom = zoom;
        this.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
        const cx = (cw - this.imageWidth * zoom) / 2;
        const cy = (ch - this.imageHeight * zoom) / 2;
        this.canvas.setViewportTransform([zoom, 0, 0, zoom, cx, cy]);
        this.canvas.requestRenderAll();
        this._updateZoomDisplay();
    },

    zoomIn() {
        let zoom = this.canvas.getZoom() * 1.3;
        zoom = Math.min(zoom, 20);
        const center = this.canvas.getCenter();
        this.canvas.zoomToPoint({ x: center.left, y: center.top }, zoom);
        this.canvas.requestRenderAll();
        this._updateZoomDisplay();
    },

    zoomOut() {
        let zoom = this.canvas.getZoom() * 0.7;
        zoom = Math.max(zoom, 0.05);
        const center = this.canvas.getCenter();
        this.canvas.zoomToPoint({ x: center.left, y: center.top }, zoom);
        this.canvas.requestRenderAll();
        this._updateZoomDisplay();
    },

    _updateZoomDisplay() {
        const pct = Math.round(this.canvas.getZoom() * 100 / this._baseZoom);
        const el = document.getElementById('zoomLevel');
        if (el) el.textContent = pct + '%';
    },

    _baseZoom: 1,

    clearOverlays() {
        const objects = this.canvas.getObjects().slice();
        for (const obj of objects) {
            if (obj !== this.bgImage) {
                this.canvas.remove(obj);
            }
        }
        this.canvas.requestRenderAll();
    },

    addObject(obj) {
        this.canvas.add(obj);
    },

    removeObject(obj) {
        this.canvas.remove(obj);
    },

    render() {
        this.canvas.requestRenderAll();
    },
};
