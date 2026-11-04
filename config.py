"""Configuration for P&ID Web Annotation Tool"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# URL prefix for deployment behind a reverse proxy (e.g. "/pnid_anno").
# Set the URL_PREFIX environment variable to configure. Empty string for local dev.
URL_PREFIX = os.environ.get('URL_PREFIX', '').rstrip('/')
UPLOAD_DIR = os.environ.get('PNID_UPLOAD_DIR', '').strip() or os.path.join(BASE_DIR, 'uploads')
PNIDAGENT_DIR = os.path.join(BASE_DIR, 'PnIDAgent')
DATA_DIR = os.path.join(BASE_DIR, 'data')          # classes.csv, actuators.csv (label sets)

# Model paths
YOLO_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best.pt')
SAM2_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best_model.pth')
SAM2_BASE_MODEL = 'facebook/sam2-hiera-base-plus'

# Manual annotation mode: no ML pipeline (no YOLO / SAM2 / CLIP / PaddleOCR, no model weights).
# Turned on with PNID_MANUAL_ONLY=1, or automatically when the PnIDAgent submodule is not checked out.
# Every session then starts with empty result files so the Symbols, Classification, Text, Lines and
# Graph tabs work right after an image is uploaded.
PIPELINE_AVAILABLE = os.path.exists(os.path.join(PNIDAGENT_DIR, 'process_text_lines.py'))
MANUAL_ONLY = os.environ.get('PNID_MANUAL_ONLY', '').strip().lower() in ('1', 'true', 'yes') or not PIPELINE_AVAILABLE

# Folder the "Save to output" button writes the session's result files to (e.g. the output/ folder of
# an evaluation task). Unset = button hidden; results are still downloadable as a ZIP.
OUTPUT_DIR = os.environ.get('PNID_OUTPUT_DIR', '').strip() or None

# Pipeline defaults
DEFAULT_DETECTOR = 'yolo'
DEFAULT_CONFIDENCE = 0.5
DEFAULT_EMBEDDING_MODEL = 'clip'
DEFAULT_CLUSTERING_METHOD = 'hdbscan'
DEFAULT_SENSITIVITY = 'high'
DEFAULT_TARGET_WIDTH = 7168
DEFAULT_DEVICE = 'cuda'
DEFAULT_NMS_IOU = 0.3
DEFAULT_MIN_LINE_LEN = 22
DEFAULT_MAX_TEXT_DISTANCE = 200.0
DEFAULT_MAX_LINE_DISTANCE = 300.0

# Symbol library for shape matching
SYMBOLS_DIR = os.path.join(BASE_DIR, 'symbols')

# Upload limits
MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500MB
ALLOWED_IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.pdf'}
