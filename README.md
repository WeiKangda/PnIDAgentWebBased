# PnIDAgent Web Tool

A web-based annotation and digitization tool for Piping & Instrumentation Diagrams (P&IDs). Built with Flask and Fabric.js, it provides an interactive workspace for AI-assisted symbol detection, text recognition, line tracing, and graph export.

## Features

- **Upload** P&ID images (PNG, JPG, TIFF, PDF) or pre-processed result ZIPs
- **Symbol Detection** via YOLO + SAM2 segmentation
- **Symbol Classification** using CLIP/DINOv2 embeddings + HDBSCAN clustering
- **Text Detection** with PaddleOCR
- **Line Detection** (solid & dashed), either the classical Hough path or a U-Net pipe-centreline segmenter
- **Topology Assembly** — a junction-aware pipe graph, so tees and crossings become explicit nodes
- **Interactive Editing** — add, delete, or modify symbols, text, and lines on a canvas
- **Graph Export** — digitized P&ID as structured JSON (nodes + edges)

## Prerequisites

- Python 3.9
- CUDA-capable GPU (recommended for ML pipeline)
- Git
- [uv](https://docs.astral.sh/uv/) — install with:
  ```bash
  # macOS / Linux
  curl -LsSf https://astral.sh/uv/install.sh | sh

  # Windows
  powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
  ```

## Setup

### 1. Clone the repository

```bash
git clone --recurse-submodules https://github.com/WeiKangda/PnIDAgentWebBased.git
cd PnIDAgentWebBased
```

If you already cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
```

### 2. Download model weights

All model files go in the `PnIDAgent/` directory. The two detectors are published
as GitHub release assets:

```bash
curl -L -o PnIDAgent/best.pt \
  https://github.com/WeiKangda/PnIDAgent/releases/download/yolo-model-v1/best.pt
curl -L -o PnIDAgent/line_seg_best.pt \
  https://github.com/WeiKangda/PnIDAgent/releases/download/lineseg-model-v1/line_seg_best.pt
```

| File | Description | Source |
|------|-------------|--------|
| `best.pt` | YOLO symbol detector, macro F1 0.888 on four real nuclear drawings | [`yolo-model-v1`](https://github.com/WeiKangda/PnIDAgent/releases/tag/yolo-model-v1) |
| `line_seg_best.pt` | U-Net pipe-centreline segmenter (optional) | [`lineseg-model-v1`](https://github.com/WeiKangda/PnIDAgent/releases/tag/lineseg-model-v1) |
| `best_model.pth` | Fine-tuned SAM2 segmentation model (optional) | Box, link below |

> **Box download link (SAM2):** https://inlbox.box.com/s/lpd4mfxshhb8okjccbnkrevvq6mkl9ic

`line_seg_best.pt` is only needed for the `unet` line source. Without it the Line
Detection step uses the classical Hough path, so the app still runs end to end.
Put it elsewhere by setting `LINE_SEG_MODEL_PATH`. `best_model.pth` is only needed
if you select the SAM2 detector instead of YOLO.

### 3. Create environment with uv

```bash
uv venv pnid_env --python 3.9

# macOS / Linux
source pnid_env/bin/activate

# Windows
pnid_env\Scripts\activate
```

### 4. Install dependencies

```bash
uv pip install -r PnIDAgent/requirements.txt
uv pip install -r requirements.txt
```

#### Optional: separate OCR environment

PaddleOCR and PyTorch do not always coexist. `paddleocr` pins an older OpenCV,
and `paddlepaddle-gpu` downgrades the NCCL/cuDNN builds that `torch` expects, so
on a GPU node installing both into one environment can break either the U-Net or
the OCR step. If that happens, build a second environment with the PaddleOCR
stack only and point the app at its interpreter:

```bash
uv venv pnid_ocr --python 3.9
uv pip install --python pnid_ocr/bin/python paddleocr==2.7.3 paddlepaddle==3.3.0 \
    'opencv-python-headless>=4.8,<4.13' 'numpy>=1.26,<3'

OCR_PYTHON=$PWD/pnid_ocr/bin/python python app.py
```

The text and line detection step runs as a subprocess, so it is the only part
that uses `OCR_PYTHON`; everything else stays in the main environment. On Apple
Silicon note that `paddlepaddle==2.6.2` segfaults — use 3.1.0 or newer.

### 5. Run the app

```bash
python app.py
```

Open [http://localhost:5001](http://localhost:5001) in your browser.

### Optional: Cloudflare Tunnel deployment

```bash
bash start_tunnel.sh
```

This starts the Flask app and exposes it via Cloudflare Tunnel. Requires `cloudflared` to be installed and configured.

## Usage

1. **Upload** a P&ID image or a previously exported ZIP on the landing page
2. **Run Pipeline** steps sequentially from the Pipeline tab:
   - Symbol Detection → Classification → Text Detection → Line Detection → Digitization
3. **Edit** results interactively using the Symbols, Classification, Text, and Lines tabs
4. **Export** the digitized graph as JSON or download all results as a ZIP

Classification is optional. Going straight from Symbol Detection to Digitization
labels every detection `symbol`, which is enough to build the connectivity graph.

### Choosing a line extractor

The dropdown next to the Text & Line Detection button selects the extractor:

| Source | Needs | Notes |
|--------|-------|-------|
| `classical` | nothing extra | Hough transform plus collinear merging |
| `unet` | `torch` + `line_seg_best.pt` | Better recall on dashed and broken pipe runs |

Picking `unet` when the checkpoint or `torch` is missing falls back to the
classical result and shows a warning rather than failing the step. The classical
geometry is always kept alongside as `*_step4_lines_classical.json`, so the two
can be compared on the same sheet.

### Junctions in the graph view

With the `topology` assembler the graph gains junction nodes where pipe runs
meet. They are drawn as small grey diamonds, distinct from the square symbol
nodes, and counted separately in the stats bar. Switch to `chains` (legacy
endpoint chaining) by posting `{"assembler": "chains"}` to the digitize
endpoint.

## Project Structure

```
PnIDAgentWebBased/
├── app.py                  # Flask application entry point
├── config.py               # Configuration (model paths, defaults)
├── requirements.txt        # Web app dependencies (Flask, Gunicorn)
├── start_tunnel.sh         # Cloudflare Tunnel deployment script
├── api/                    # REST API endpoints (Flask blueprints)
│   ├── upload.py           # Image/ZIP upload, session creation
│   ├── pipeline_api.py     # ML pipeline execution
│   ├── classification.py   # Symbol classification editing
│   ├── masks.py            # Symbol mask CRUD
│   ├── text.py             # Text detection CRUD
│   ├── lines.py            # Line detection CRUD
│   ├── export.py           # ZIP/JSON export
│   ├── image.py            # Image serving
│   └── session_utils.py    # Shared session helpers
├── pipeline/               # Pipeline integration wrappers
│   ├── runner.py           # Step orchestration helpers
│   └── unet_lines.py       # Single-image wrapper for the U-Net line segmenter
├── templates/              # HTML templates (index, workspace)
├── static/                 # Frontend assets (JS, CSS, Fabric.js)
├── symbols/                # Reference symbol libraries (Surry, NorthANA)
└── PnIDAgent/              # ML pipeline (git submodule)
```

## Configuration

Key settings in `config.py`:

| Setting | Default | Description |
|---------|---------|-------------|
| `DEFAULT_CONFIDENCE` | 0.5 | YOLO detection confidence threshold |
| `DEFAULT_TARGET_WIDTH` | 7168 | Image resize target width (px) |
| `DEFAULT_DEVICE` | `cuda` | PyTorch device (`cuda` or `cpu`) |
| `DEFAULT_EMBEDDING_MODEL` | `clip` | Embedding model for classification |
| `DEFAULT_CLUSTERING_METHOD` | `hdbscan` | Clustering algorithm |
| `DEFAULT_LINE_SOURCE` | `classical` | Line extractor (`classical` or `unet`) |
| `DEFAULT_UNET_TILE` | 1024 | U-Net inference tile size (px) |
| `DEFAULT_UNET_MIN_LINE_LEN` | 100 | Shortest segment kept from the U-Net mask (px) |
| `DEFAULT_ASSEMBLER` | `topology` | Graph assembler (`topology` or `chains`) |
| `DEFAULT_SNAP_TOL` | 12 | Endpoint snapping radius (px) |
| `DEFAULT_SYMBOL_PAD` | 6 | How far outside its box a symbol claims a dead end (px) |
| `MAX_CONTENT_LENGTH` | 500 MB | Max upload file size |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `URL_PREFIX` | `""` (empty) | URL path prefix for deploying behind a reverse proxy. Set this when hosting on a subpath (e.g. `/pnid_anno`). |
| `LINE_SEG_MODEL_PATH` | `PnIDAgent/line_seg_best.pt` | U-Net pipe-centreline checkpoint. |
| `OCR_PYTHON` | `""` (same interpreter) | Interpreter for the text and line subprocess, when PaddleOCR needs its own environment. |
| `DEFAULT_LINE_SOURCE` | `classical` | Preselected line extractor in the UI. |

**Example — deploy on HPC under `/pnid_anno`:**

```bash
URL_PREFIX=/pnid_anno python app.py
```

All routes, API endpoints, and static assets will be served under the given prefix (e.g. `http://host/pnid_anno/`, `http://host/pnid_anno/api/...`). When unset, the app runs at the root path (`/`).
