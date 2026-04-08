"""Image serving API"""
import os
import io
import time
import json
import cv2
from flask import Blueprint, send_file, request, jsonify
from config import UPLOAD_DIR
from api.session_utils import get_session_dir, get_image_path

image_bp = Blueprint('image', __name__)


@image_bp.route('/session/<session_id>/image', methods=['GET'])
def serve_image(session_id):
    """Serve the session's P&ID image, optionally resized."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    # Wait for PDF conversion if still in progress (up to 120s)
    meta_path = os.path.join(session_dir, 'session.json')
    for _ in range(60):
        with open(meta_path, 'r') as mf:
            meta = json.load(mf)
        if not meta.get('pdf_converting'):
            break
        time.sleep(2)

    image_path = get_image_path(session_dir)
    if not image_path:
        return jsonify({'error': 'Image not found'}), 404

    max_width = request.args.get('max_width', type=int)

    if max_width:
        img = cv2.imread(image_path)
        if img is None:
            return jsonify({'error': 'Failed to load image'}), 500
        h, w = img.shape[:2]
        if w > max_width:
            scale = max_width / w
            new_h = int(h * scale)
            img = cv2.resize(img, (max_width, new_h), interpolation=cv2.INTER_AREA)
        _, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, 90])
        return send_file(io.BytesIO(buf.tobytes()), mimetype='image/jpeg')

    return send_file(image_path)


@image_bp.route('/session/<session_id>/image/info', methods=['GET'])
def image_info(session_id):
    """Get image dimensions."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    # Wait for PDF conversion if still in progress (up to 120s)
    meta_path = os.path.join(session_dir, 'session.json')
    for _ in range(60):
        with open(meta_path, 'r') as mf:
            meta = json.load(mf)
        if not meta.get('pdf_converting'):
            break
        time.sleep(2)

    image_path = get_image_path(session_dir)
    if not image_path:
        return jsonify({'error': 'Image not found'}), 404

    img = cv2.imread(image_path)
    if img is None:
        return jsonify({'error': 'Failed to load image'}), 500

    h, w = img.shape[:2]
    return jsonify({'width': w, 'height': h, 'filename': os.path.basename(image_path)})
