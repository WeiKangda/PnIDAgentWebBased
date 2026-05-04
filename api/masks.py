"""Masks (Symbol) Editor API"""
import os
import json
import numpy as np
import cv2
import io
from flask import Blueprint, request, jsonify, send_file
from config import UPLOAD_DIR
from api.session_utils import (
    get_session_dir, find_file, load_json_file, save_json_file,
    get_image_path, get_image_stem
)

masks_bp = Blueprint('masks', __name__)


@masks_bp.route('/session/<session_id>/masks', methods=['GET'])
def get_masks(session_id):
    """Get all mask info (bboxes, scores, ids)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No symbol detection results found'}), 404

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    return jsonify({
        'num_masks': len(masks_info),
        'masks': masks_info,
    })


@masks_bp.route('/session/<session_id>/masks/<int:mask_id>', methods=['DELETE'])
def delete_mask(session_id, mask_id):
    """Delete a mask by ID."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No results found'}), 404

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    # Find and remove mask with matching id
    masks_info = [m for m in masks_info if m['id'] != mask_id]

    data['masks_info'] = masks_info
    data['num_masks'] = len(masks_info)
    save_json_file(results_path, data)

    # Also update masks.npz if it exists
    _sync_masks_npz(session_dir, masks_info)

    # Remove from classification data if it exists
    _sync_classification(session_dir, [mask_id])

    return jsonify({'success': True, 'num_masks': len(masks_info)})


@masks_bp.route('/session/<session_id>/masks', methods=['POST'])
def create_mask(session_id):
    """Create a new mask from a bounding box."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No results found'}), 404

    body = request.get_json()
    bbox = body.get('bbox')  # [x1, y1, x2, y2]
    if not bbox or len(bbox) != 4:
        return jsonify({'error': 'bbox must be [x1, y1, x2, y2]'}), 400

    x1, y1, x2, y2 = [int(v) for v in bbox]

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    # Generate new ID (max + 1)
    max_id = max((m['id'] for m in masks_info), default=-1)
    new_id = max_id + 1

    area = (x2 - x1) * (y2 - y1)
    new_mask = {
        'id': new_id,
        'score': 1.0,
        'area': area,
        'bbox': [x1, y1, x2, y2],
        'center': [(x1 + x2) // 2, (y1 + y2) // 2],
    }

    masks_info.append(new_mask)
    data['masks_info'] = masks_info
    data['num_masks'] = len(masks_info)
    save_json_file(results_path, data)

    _sync_masks_npz(session_dir, masks_info)

    return jsonify({'success': True, 'mask': new_mask})


@masks_bp.route('/session/<session_id>/masks/<int:mask_id>', methods=['PUT'])
def update_mask(session_id, mask_id):
    """Update a mask's bounding box, angle, and rotated bbox."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No results found'}), 404

    body = request.get_json()
    bbox = body.get('bbox')
    angle = body.get('angle')
    rotated_bbox = body.get('rotated_bbox')

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    for m in masks_info:
        if m['id'] == mask_id:
            if bbox:
                x1, y1, x2, y2 = [int(v) for v in bbox]
                m['bbox'] = [x1, y1, x2, y2]
                m['center'] = [(x1 + x2) // 2, (y1 + y2) // 2]
                m['area'] = (x2 - x1) * (y2 - y1)
            if angle is not None:
                m['angle'] = angle
            if rotated_bbox is not None:
                m['rotated_bbox'] = rotated_bbox
                # Use rotated_bbox center as the mask center
                m['center'] = [int(rotated_bbox['cx']), int(rotated_bbox['cy'])]
                m['area'] = int(rotated_bbox['width'] * rotated_bbox['height'])
            break
    else:
        return jsonify({'error': 'Mask not found'}), 404

    data['masks_info'] = masks_info
    save_json_file(results_path, data)
    _sync_masks_npz(session_dir, masks_info)

    return jsonify({'success': True})


@masks_bp.route('/session/<session_id>/masks/merge', methods=['POST'])
def merge_masks(session_id):
    """Merge multiple masks into one (union bounding box)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No results found'}), 404

    body = request.get_json()
    ids_to_merge = body.get('ids', [])
    if len(ids_to_merge) < 2:
        return jsonify({'error': 'Need at least 2 mask IDs to merge'}), 400

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    ids_set = set(ids_to_merge)
    to_merge = [m for m in masks_info if m['id'] in ids_set]
    remaining = [m for m in masks_info if m['id'] not in ids_set]

    if len(to_merge) < 2:
        return jsonify({'error': 'Could not find enough masks to merge'}), 400

    # Compute union bbox
    x1 = min(m['bbox'][0] for m in to_merge)
    y1 = min(m['bbox'][1] for m in to_merge)
    x2 = max(m['bbox'][2] for m in to_merge)
    y2 = max(m['bbox'][3] for m in to_merge)

    avg_score = sum(m['score'] for m in to_merge) / len(to_merge)
    max_id = max((m['id'] for m in masks_info), default=-1)

    merged = {
        'id': max_id + 1,
        'score': avg_score,
        'area': (x2 - x1) * (y2 - y1),
        'bbox': [x1, y1, x2, y2],
        'center': [(x1 + x2) // 2, (y1 + y2) // 2],
    }

    remaining.append(merged)
    data['masks_info'] = remaining
    data['num_masks'] = len(remaining)
    save_json_file(results_path, data)
    _sync_masks_npz(session_dir, remaining)

    # Remove merged-away masks from classification data
    _sync_classification(session_dir, list(ids_set))

    return jsonify({'success': True, 'merged_mask': merged, 'num_masks': len(remaining)})


@masks_bp.route('/session/<session_id>/masks/bulk', methods=['PUT'])
def bulk_update_masks(session_id):
    """Bulk update all masks data (for undo/redo)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    if not results_path:
        return jsonify({'error': 'No results found'}), 404

    body = request.get_json()
    masks_info = body.get('masks', [])

    data = load_json_file(results_path)
    data['masks_info'] = masks_info
    data['num_masks'] = len(masks_info)
    save_json_file(results_path, data)

    _sync_masks_npz(session_dir, masks_info)

    return jsonify({'success': True, 'num_masks': len(masks_info)})


@masks_bp.route('/session/<session_id>/masks/save', methods=['POST'])
def save_masks(session_id):
    """Persist current masks state (already saved on each edit, this is explicit)."""
    return jsonify({'success': True})


@masks_bp.route('/session/<session_id>/masks/<int:mask_id>/patch', methods=['GET'])
def get_mask_patch(session_id, mask_id):
    """Get cropped image patch for a mask."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    results_path = find_file(session_dir, '_sam2_results.json')
    image_path = get_image_path(session_dir)
    if not results_path or not image_path:
        return jsonify({'error': 'Data not found'}), 404

    data = load_json_file(results_path)
    masks_info = data.get('masks_info', [])

    mask = None
    for m in masks_info:
        if m['id'] == mask_id:
            mask = m
            break
    if not mask:
        return jsonify({'error': 'Mask not found'}), 404

    img = cv2.imread(image_path)
    if img is None:
        return jsonify({'error': 'Failed to load image'}), 500

    h, w = img.shape[:2]
    rbbox = mask.get('rotated_bbox')

    if rbbox and rbbox.get('angle', 0) != 0:
        # Rotated patch: crop using the rotated rectangle
        cx, cy = rbbox['cx'], rbbox['cy']
        rw, rh = rbbox['width'], rbbox['height']
        angle = rbbox['angle']
        # Use cv2.getRotationMatrix2D to rotate so the bbox becomes axis-aligned
        M = cv2.getRotationMatrix2D((cx, cy), angle, 1.0)
        rotated = cv2.warpAffine(img, M, (w, h))
        # Now crop the axis-aligned rect from the rotated image
        rx1 = max(0, int(cx - rw / 2))
        ry1 = max(0, int(cy - rh / 2))
        rx2 = min(w, int(cx + rw / 2))
        ry2 = min(h, int(cy + rh / 2))
        patch = rotated[ry1:ry2, rx1:rx2]
    else:
        x1, y1, x2, y2 = mask['bbox']
        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w, x2), min(h, y2)
        patch = img[y1:y2, x1:x2]

    if patch.size == 0:
        patch = np.zeros((32, 32, 3), dtype=np.uint8)

    _, buf = cv2.imencode('.png', patch)
    return send_file(io.BytesIO(buf.tobytes()), mimetype='image/png')


def _sync_classification(session_dir, removed_mask_ids):
    """Remove symbols with given mask_ids from classification JSON."""
    from api.session_utils import find_file, load_json_file, save_json_file
    path = find_file(session_dir, '_classification.json')
    if not path:
        return
    data = load_json_file(path)
    if not data:
        return

    removed_set = set(removed_mask_ids)
    changed = False

    for key in ('symbols', 'discarded_symbols'):
        syms = data.get(key, [])
        filtered = [s for s in syms if s.get('mask_id', s.get('id')) not in removed_set]
        if len(filtered) != len(syms):
            data[key] = filtered
            changed = True

    if changed:
        # Rebuild categories
        all_syms = data.get('symbols', []) + data.get('discarded_symbols', [])
        categories = {}
        for sym in all_syms:
            cat = sym.get('category', 'Unknown')
            categories[cat] = categories.get(cat, 0) + 1
        data['categories'] = categories
        data['num_clusters'] = len(set(s.get('cluster_id', 0) for s in all_syms))
        save_json_file(path, data)


def _sync_masks_npz(session_dir, masks_info):
    """Regenerate masks.npz from masks_info (bbox-based masks)."""
    npz_path = find_file(session_dir, '_masks.npz')
    if not npz_path:
        return

    image_path = get_image_path(session_dir)
    if not image_path:
        return

    img = cv2.imread(image_path)
    if img is None:
        return

    h, w = img.shape[:2]

    if len(masks_info) == 0:
        np.savez_compressed(
            npz_path,
            masks=np.array([]),
            scores=np.array([]),
            image_shape=img.shape,
            num_masks=0
        )
        return

    masks = []
    scores = []
    for m in masks_info:
        mask = np.zeros((h, w), dtype=np.uint8)
        rbbox = m.get('rotated_bbox')
        if rbbox and rbbox.get('angle', 0) != 0:
            # Rotated mask: draw filled rotated rectangle
            cx, cy = rbbox['cx'], rbbox['cy']
            rw, rh = rbbox['width'], rbbox['height']
            angle = rbbox['angle']
            box = cv2.boxPoints(((cx, cy), (rw, rh), angle))
            box = np.intp(box)
            cv2.fillConvexPoly(mask, box, 1)
        else:
            x1, y1, x2, y2 = m['bbox']
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            mask[y1:y2, x1:x2] = 1
        masks.append(mask.astype(bool))
        scores.append(m['score'])

    np.savez_compressed(
        npz_path,
        masks=np.array(masks),
        scores=np.array(scores),
        image_shape=img.shape,
        num_masks=len(masks)
    )
