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
  curl -LsSf https://astral.sh/uv/install.sh | sh
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
source pnid_env/bin/activate
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
