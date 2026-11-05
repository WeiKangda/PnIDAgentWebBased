# PnIDAgent Web Tool

A web-based annotation and digitization tool for Piping & Instrumentation Diagrams (P&IDs). Built with Flask and Fabric.js, it provides an interactive workspace for AI-assisted symbol detection, text recognition, line tracing, and graph export.

## Features

- **Upload** P&ID images (PNG, JPG, TIFF, PDF) or pre-processed result ZIPs
- **Symbol Detection** via YOLO + SAM2 segmentation
- **Symbol Classification** using CLIP/DINOv2 embeddings + HDBSCAN clustering
- **Text Detection** with PaddleOCR
- **Line Detection** (solid & dashed) with configurable parameters
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

Download the following model files from Box and place them in the `PnIDAgent/` directory:

| File | Description | Destination |
|------|-------------|-------------|
| `best.pt` | Fine-tuned YOLO symbol detector | `PnIDAgent/best.pt` |
| `best_model.pth` | Fine-tuned SAM2 segmentation model | `PnIDAgent/best_model.pth` |

> **Box download link:** https://inlbox.box.com/s/lpd4mfxshhb8okjccbnkrevvq6mkl9ic

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

## Manual annotation mode (no ML, offline)

The tool also runs without the ML pipeline: no PnIDAgent submodule, no model weights, no GPU, no
internet. Start it with

```bash
PNID_MANUAL_ONLY=1 python app.py
```

(it switches to this mode by itself when the `PnIDAgent/` submodule is not checked out). Every session
then starts with empty result files, so the Symbols, Classification, Text, Lines and Graph tabs work right
after an image is uploaded; the Pipeline tab is hidden and the pipeline endpoints answer 400. Only Flask,
numpy and OpenCV are needed (`pip install flask numpy opencv-python-headless`).

What the editors write:

| tab | file | notes |
|---|---|---|
| Symbols | `<stem>_symbols.json` | one `masks_info` entry per box, image pixels |
| Classification | `<stem>_classification.json` | `category` = `CLASS` or `CLASS/ACTUATOR` (e.g. `VLV_GATE/MOTOR`), chosen from the dropdowns fed by `data/classes.csv` and `data/actuators.csv`; new boxes start in the `unlabeled` cluster, select them and use *Label Selected…* |
| Text | `<stem>_text.json` | `bbox`, `text` and `rot` (`0`, `cw`, `ccw`, `180` = reading direction), image pixels (`scale` 1.0) |
| Lines | `<stem>_lines.json` | `solid` / `dashed` segments, image pixels |
| Graph | `<stem>_connections.json` | one node per box (kept in step with the Symbols tab), `links` = the connections drawn with *Add Connection*; the drawing is shown under the graph |

Other additions: `PNID_OUTPUT_DIR=<folder>` adds a *Save to Output* button that copies the five result
files there; `PNID_UPLOAD_DIR` moves the session store; `tools/new_session.py <image> [--id ID]` creates a
session without the browser upload (optionally from an earlier result folder or ZIP) and prints its URL;
`GET /api/label-sets` returns the class and actuator lists.

On a machine without internet or pip, put the wheels of flask, numpy and opencv-python-headless (with their
dependencies) into `vendor/`, one `pip download` per Python version the machine may have, e.g.

```bash
pip download -r requirements-manual.txt -d vendor --only-binary=:all: --platform manylinux2014_x86_64 --python-version 3.10
```

and start the tool with

```bash
LIB="$(python3 tools/offline_deps.py)" && export PYTHONPATH="$LIB${PYTHONPATH:+:$PYTHONPATH}"
PNID_MANUAL_ONLY=1 python3 app.py
```

`tools/offline_deps.py` prints nothing when the packages already import. Otherwise it unpacks the wheels that
fit the running interpreter (Python tag, ABI, machine, glibc) into `pylib/<tag>-<machine>/`, checks the imports
from there and prints that folder; a wheel is a ZIP of what pip would copy into site-packages, so no pip, venv
or root is needed. `vendor/` and `pylib/` are ignored by git.

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
├── pipeline/               # Pipeline integration wrapper
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
| `MAX_CONTENT_LENGTH` | 500 MB | Max upload file size |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `URL_PREFIX` | `""` (empty) | URL path prefix for deploying behind a reverse proxy. Set this when hosting on a subpath (e.g. `/pnid_anno`). |

**Example — deploy on HPC under `/pnid_anno`:**

```bash
URL_PREFIX=/pnid_anno python app.py
```

All routes, API endpoints, and static assets will be served under the given prefix (e.g. `http://host/pnid_anno/`, `http://host/pnid_anno/api/...`). When unset, the app runs at the root path (`/`).
