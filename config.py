"""Configuration for P&ID Web Annotation Tool"""
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, 'uploads')
PNIDAGENT_DIR = os.path.join(BASE_DIR, 'PnIDAgent')

# Model paths
YOLO_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best.pt')
SAM2_MODEL_PATH = os.path.join(PNIDAGENT_DIR, 'best_model.pth')
SAM2_BASE_MODEL = 'facebook/sam2-hiera-base-plus'

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
