"""Session utilities - shared helpers for API blueprints"""
import os
import json
import glob
import numpy as np
from config import UPLOAD_DIR


def get_session_dir(session_id):
    """Get session directory path, raise if not exists."""
    d = os.path.join(UPLOAD_DIR, session_id)
    if not os.path.isdir(d):
        return None
    return d


def load_session_meta(session_id):
    """Load session.json metadata."""
    d = get_session_dir(session_id)
    if not d:
        return None
    meta_path = os.path.join(d, 'session.json')
    if not os.path.exists(meta_path):
        return None
    with open(meta_path, 'r') as f:
        return json.load(f)


def save_session_meta(session_id, meta):
    """Save session.json metadata."""
    d = get_session_dir(session_id)
    if not d:
        return
    with open(os.path.join(d, 'session.json'), 'w') as f:
        json.dump(meta, f, indent=2)


def find_file(session_dir, suffix):
    """Find a file in session dir matching *suffix."""
    matches = glob.glob(os.path.join(session_dir, f'*{suffix}'))
    return matches[0] if matches else None


def get_image_stem(session_dir):
    """Get the image stem name from session metadata."""
    meta_path = os.path.join(session_dir, 'session.json')
    if os.path.exists(meta_path):
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        return meta.get('image_stem', '')
    return ''


def load_json_file(path):
    """Load a JSON file."""
    if not path or not os.path.exists(path):
        return None
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json_file(path, data):
    """Save data to JSON file."""
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_masks_info(session_dir):
    """Load masks info from sam2_results.json."""
    path = find_file(session_dir, '_sam2_results.json')
    if not path:
        return None
    data = load_json_file(path)
    return data


def get_text_data(session_dir):
    """Load text detections from step3_text.json."""
    path = find_file(session_dir, '_step3_text.json')
    return load_json_file(path) if path else None


def get_lines_data(session_dir):
    """Load lines from step4_lines.json."""
    path = find_file(session_dir, '_step4_lines.json')
    return load_json_file(path) if path else None


def get_classification_data(session_dir):
    """Load classification from classification.json."""
    path = find_file(session_dir, '_classification.json')
    return load_json_file(path) if path else None


def get_image_path(session_dir):
    """Find the original image in session directory."""
    for ext in ['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']:
        matches = glob.glob(os.path.join(session_dir, f'*{ext}'))
        # Filter out visualization/overlay images
        for m in matches:
            base = os.path.basename(m).lower()
            if not any(k in base for k in ['visualization', 'overlay', 'masks', 'clusters', 'categorized']):
                return m
    return None
