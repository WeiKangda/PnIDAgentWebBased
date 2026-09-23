"""Configuration for P&ID Web Annotation Tool"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# URL prefix for deployment behind a reverse proxy (e.g. "/pnid_anno").
# Set the URL_PREFIX environment variable to configure. Empty string for local dev.
URL_PREFIX = os.environ.get('URL_PREFIX', '').rstrip('/')
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
PNIDAGENT_DIR = os.path.join(BASE_DIR, 'PnIDAgent')

# Model paths
YOLO_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best.pt')
SAM2_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best_model.pth')
SAM2_BASE_MODEL = 'facebook/sam2-hiera-base-plus'

# U-Net pipe-centreline extractor (eval_tools/line_seg.py). Optional: needs torch
# and a checkpoint. Trained on 450 synthetic sheets; F1 0.986 on the 50-sheet
# synthetic validation split vs 0.931 for the tuned classical path.
LINE_SEG_MODEL_PATH = os.environ.get(
    'LINE_SEG_MODEL_PATH', os.path.join(PNIDAGENT_DIR, 'line_seg_best.pt'))

# PaddleOCR and torch cannot share one environment: paddleocr pins opencv 4.6 and
# paddlepaddle-gpu downgrades the nccl/cudnn that torch needs. Point this at the
# interpreter of the OCR environment; the text/line subprocess uses it.
OCR_PYTHON = os.environ.get('OCR_PYTHON', '')

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

# Line extractor: 'classical' (Hough, no extra dependencies) or 'unet' (needs
# torch + LINE_SEG_MODEL_PATH). 'unet' falls back to 'classical' if unavailable.
DEFAULT_LINE_SOURCE = os.environ.get('DEFAULT_LINE_SOURCE', 'classical')
DEFAULT_UNET_TILE = 1024
DEFAULT_UNET_MIN_LINE_LEN = 100

# Graph assembly: 'topology' builds a pipe graph with junction nodes;
# 'chains' is the legacy endpoint-chaining assembler. On synthetic sheets with
# ground-truth inputs the chains recover 12.4% of true pipe runs, topology 100%.
DEFAULT_ASSEMBLER = 'topology'
DEFAULT_SNAP_TOL = 12       # endpoint snapping radius, px
DEFAULT_SYMBOL_PAD = 6      # how far outside its box a symbol claims a dead end, px

# Symbol library for shape matching
SYMBOLS_DIR = os.path.join(BASE_DIR, 'symbols')

# Upload limits
MAX_CONTENT_LENGTH = 500 * 1024 * 1024  # 500MB
ALLOWED_IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.pdf'}
