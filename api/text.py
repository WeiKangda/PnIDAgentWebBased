"""Text Editor API"""
import os
import json
from flask import Blueprint, request, jsonify
from config import UPLOAD_DIR
from api.session_utils import get_session_dir, find_file, load_json_file, save_json_file

text_bp = Blueprint('text', __name__)


@text_bp.route('/session/<session_id>/text', methods=['GET'])
def get_text(session_id):
    """Get all text detections."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text detection data found'}), 404

    data = load_json_file(path)
    detections = data if isinstance(data, list) else data.get('detections', [])

    return jsonify({
        'num_detections': len(detections),
        'detections': detections,
    })


@text_bp.route('/session/<session_id>/text/<int:idx>', methods=['PUT'])
def update_text(session_id, idx):
    """Update text content and/or bbox for a detection."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text data found'}), 404

    body = request.get_json()

    data = load_json_file(path)
    detections = data if isinstance(data, list) else data.get('detections', [])

    if idx < 0 or idx >= len(detections):
        return jsonify({'error': 'Index out of range'}), 404

    if 'text' in body:
        detections[idx]['text'] = body['text']
    if 'bbox' in body:
        bbox = body['bbox']
        if isinstance(bbox, list) and len(bbox) == 4:
            detections[idx]['bbox'] = [int(v) for v in bbox]

    save_json_file(path, detections)

    return jsonify({'success': True})


@text_bp.route('/session/<session_id>/text/<int:idx>', methods=['DELETE'])
def delete_text(session_id, idx):
    """Delete a text detection."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text data found'}), 404

    data = load_json_file(path)
    detections = data if isinstance(data, list) else data.get('detections', [])

    if idx < 0 or idx >= len(detections):
        return jsonify({'error': 'Index out of range'}), 404

    detections.pop(idx)
    save_json_file(path, detections)

    return jsonify({'success': True, 'num_detections': len(detections)})


@text_bp.route('/session/<session_id>/text', methods=['POST'])
def create_text(session_id):
    """Create a new text detection from a bounding box."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text data found'}), 404

    body = request.get_json()
    bbox = body.get('bbox')
    text = body.get('text', '')
    if not bbox or len(bbox) != 4:
        return jsonify({'error': 'bbox must be [x1, y1, x2, y2]'}), 400

    x1, y1, x2, y2 = [int(v) for v in bbox]

    data = load_json_file(path)
    detections = data if isinstance(data, list) else data.get('detections', [])

    new_det = {
        'bbox': [x1, y1, x2, y2],
        'text': text,
        'score': 1.0,
    }
    detections.append(new_det)
    save_json_file(path, detections)

    return jsonify({
        'success': True,
        'index': len(detections) - 1,
        'detection': new_det,
    })


@text_bp.route('/session/<session_id>/text/combine', methods=['POST'])
def combine_text(session_id):
    """Combine multiple text detections into one."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text data found'}), 404

    body = request.get_json()
    indices = body.get('indices', [])
    if len(indices) < 2:
        return jsonify({'error': 'Need at least 2 indices to combine'}), 400

    data = load_json_file(path)
    detections = data if isinstance(data, list) else data.get('detections', [])

    # Validate indices
    for i in indices:
        if i < 0 or i >= len(detections):
            return jsonify({'error': f'Index {i} out of range'}), 400

    # Combine in given order
    to_combine = [detections[i] for i in indices]
    combined_text = ' '.join(d.get('text', '') for d in to_combine)

    all_bboxes = [d['bbox'] for d in to_combine]
    x1 = min(b[0] for b in all_bboxes)
    y1 = min(b[1] for b in all_bboxes)
    x2 = max(b[2] for b in all_bboxes)
    y2 = max(b[3] for b in all_bboxes)

    avg_score = sum(d.get('score', 0.0) for d in to_combine) / len(to_combine)

    combined = {
        'bbox': [x1, y1, x2, y2],
        'text': combined_text,
        'score': avg_score,
    }

    # Remove old (from end to preserve indices)
    for i in sorted(indices, reverse=True):
        detections.pop(i)

    # Insert at position of first
    insert_pos = min(indices)
    detections.insert(insert_pos, combined)

    save_json_file(path, detections)

    return jsonify({
        'success': True,
        'combined': combined,
        'insert_index': insert_pos,
        'num_detections': len(detections),
    })


@text_bp.route('/session/<session_id>/text/save', methods=['POST'])
def save_text(session_id):
    """Persist text data (already saved on each edit)."""
    return jsonify({'success': True})


@text_bp.route('/session/<session_id>/text/bulk', methods=['PUT'])
def bulk_update_text(session_id):
    """Bulk update all text detections (used for undo/redo)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step3_text.json')
    if not path:
        return jsonify({'error': 'No text data found'}), 404

    body = request.get_json()
    detections = body.get('detections', [])

    save_json_file(path, detections)

    return jsonify({'success': True, 'num_detections': len(detections)})
