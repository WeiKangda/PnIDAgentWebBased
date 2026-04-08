"""Lines Editor API"""
import os
import json
import math
import numpy as np
from flask import Blueprint, request, jsonify
from config import UPLOAD_DIR
from api.session_utils import get_session_dir, find_file, load_json_file, save_json_file

lines_bp = Blueprint('lines', __name__)


@lines_bp.route('/session/<session_id>/lines', methods=['GET'])
def get_lines(session_id):
    """Get all line detections."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line detection data found'}), 404

    data = load_json_file(path)
    solid = data.get('solid', [])
    dashed = data.get('dashed', [])
    directions = data.get('directions', {})
    resized_shape = data.get('resized_shape', None)
    target_width = data.get('target_width', None)
    scale = data.get('scale', None)

    return jsonify({
        'solid': solid,
        'dashed': dashed,
        'directions': directions,
        'resized_shape': resized_shape,
        'target_width': target_width,
        'scale': scale,
        'num_solid': len(solid),
        'num_dashed': len(dashed),
    })


@lines_bp.route('/session/<session_id>/lines', methods=['POST'])
def add_line(session_id):
    """Add a new line."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    body = request.get_json()
    line = body.get('line')  # [x1, y1, x2, y2]
    line_type = body.get('type', 'solid')  # 'solid' or 'dashed'

    if not line or len(line) != 4:
        return jsonify({'error': 'line must be [x1, y1, x2, y2]'}), 400

    data = load_json_file(path)
    line_coords = [int(v) for v in line]

    if line_type == 'dashed':
        data.setdefault('dashed', []).append(line_coords)
    else:
        data.setdefault('solid', []).append(line_coords)

    save_json_file(path, data)

    return jsonify({
        'success': True,
        'type': line_type,
        'index': len(data.get(line_type, [])) - 1,
    })


@lines_bp.route('/session/<session_id>/lines/<line_type>/<int:idx>', methods=['DELETE'])
def delete_line(session_id, line_type, idx):
    """Delete a line by type and index."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    if line_type not in ('solid', 'dashed'):
        return jsonify({'error': 'type must be solid or dashed'}), 400

    data = load_json_file(path)
    lines = data.get(line_type, [])

    if idx < 0 or idx >= len(lines):
        return jsonify({'error': 'Index out of range'}), 404

    lines.pop(idx)
    data[line_type] = lines

    # Also clean up direction for this line
    directions = data.get('directions', {})
    key = f'{line_type}_{idx}'
    if key in directions:
        del directions[key]
    # Re-index directions after this index
    new_directions = {}
    for k, v in directions.items():
        parts = k.rsplit('_', 1)
        if len(parts) == 2 and parts[0] == line_type:
            old_idx = int(parts[1])
            if old_idx > idx:
                new_directions[f'{line_type}_{old_idx - 1}'] = v
            else:
                new_directions[k] = v
        else:
            new_directions[k] = v
    data['directions'] = new_directions

    save_json_file(path, data)

    return jsonify({'success': True})


@lines_bp.route('/session/<session_id>/lines/<line_type>/<int:idx>', methods=['PUT'])
def update_line(session_id, line_type, idx):
    """Update a line (toggle type, set direction, update coordinates)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    if line_type not in ('solid', 'dashed'):
        return jsonify({'error': 'type must be solid or dashed'}), 400

    body = request.get_json()
    data = load_json_file(path)
    lines = data.get(line_type, [])

    if idx < 0 or idx >= len(lines):
        return jsonify({'error': 'Index out of range'}), 404

    # Update coordinates if provided
    new_coords = body.get('line')
    if new_coords:
        lines[idx] = [int(v) for v in new_coords]

    # Toggle type if requested
    new_type = body.get('new_type')
    if new_type and new_type != line_type:
        line_data = lines.pop(idx)
        data[line_type] = lines
        data.setdefault(new_type, []).append(line_data)

        # Move direction too
        directions = data.get('directions', {})
        old_key = f'{line_type}_{idx}'
        if old_key in directions:
            new_idx = len(data[new_type]) - 1
            directions[f'{new_type}_{new_idx}'] = directions.pop(old_key)
        data['directions'] = directions

        save_json_file(path, data)
        return jsonify({'success': True, 'new_type': new_type,
                        'new_index': len(data[new_type]) - 1})

    # Set direction if provided
    direction = body.get('direction')
    if direction:
        directions = data.get('directions', {})
        key = f'{line_type}_{idx}'
        if direction == 'none':
            directions.pop(key, None)
        else:
            directions[key] = direction
        data['directions'] = directions

    data[line_type] = lines
    save_json_file(path, data)

    return jsonify({'success': True})


@lines_bp.route('/session/<session_id>/lines/cleanup', methods=['POST'])
def cleanup_lines(session_id):
    """Deduplicate near-identical lines and merge collinear segments."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    body = request.get_json() or {}
    # Configurable thresholds (in resized-coord pixels)
    dedup_dist = body.get('dedup_distance', 25)        # max endpoint distance to consider duplicate
    merge_angle = body.get('merge_angle', 5.0)         # degrees tolerance for collinearity
    merge_gap = body.get('merge_gap', 30)              # max gap between collinear segment endpoints
    merge_perp = body.get('merge_perp_dist', 20)       # max perpendicular distance for collinearity
    min_length = body.get('min_length', 15)             # remove lines shorter than this

    data = load_json_file(path)
    orig_solid = len(data.get('solid', []))
    orig_dashed = len(data.get('dashed', []))

    for key in ('solid', 'dashed'):
        lines = data.get(key, [])
        if not lines:
            continue

        # Step 1: Remove very short lines
        lines = [l for l in lines if _line_length(l) >= min_length]

        # Step 2: Deduplicate near-identical lines
        lines = _dedup_lines(lines, dedup_dist)

        # Step 3: Iteratively merge collinear segments
        lines = _merge_collinear(lines, merge_angle, merge_gap, merge_perp)

        data[key] = lines

    # Rebuild directions (old indices are invalid after cleanup)
    data['directions'] = {}

    save_json_file(path, data)

    new_solid = len(data.get('solid', []))
    new_dashed = len(data.get('dashed', []))

    return jsonify({
        'success': True,
        'before': {'solid': orig_solid, 'dashed': orig_dashed},
        'after': {'solid': new_solid, 'dashed': new_dashed},
        'removed': (orig_solid + orig_dashed) - (new_solid + new_dashed),
    })


def _line_length(l):
    """Euclidean length of a line segment [x1, y1, x2, y2]."""
    return math.hypot(l[2] - l[0], l[3] - l[1])


def _line_angle(l):
    """Angle of line in degrees [0, 180)."""
    ang = math.degrees(math.atan2(l[3] - l[1], l[2] - l[0])) % 180
    return ang


def _endpoint_dist(a, b):
    """Min distance between any pair of endpoints of two lines."""
    pts_a = [(a[0], a[1]), (a[2], a[3])]
    pts_b = [(b[0], b[1]), (b[2], b[3])]
    return min(math.hypot(pa[0]-pb[0], pa[1]-pb[1])
               for pa in pts_a for pb in pts_b)


def _dedup_lines(lines, dist_thresh):
    """Remove near-duplicate lines (both endpoints within threshold)."""
    if len(lines) <= 1:
        return lines

    keep = [True] * len(lines)
    for i in range(len(lines)):
        if not keep[i]:
            continue
        for j in range(i + 1, len(lines)):
            if not keep[j]:
                continue
            a, b = lines[i], lines[j]
            # Check both orientation matchings
            d1 = max(math.hypot(a[0]-b[0], a[1]-b[1]),
                     math.hypot(a[2]-b[2], a[3]-b[3]))
            d2 = max(math.hypot(a[0]-b[2], a[1]-b[3]),
                     math.hypot(a[2]-b[0], a[3]-b[1]))
            if min(d1, d2) < dist_thresh:
                # Keep the longer one
                if _line_length(a) >= _line_length(b):
                    keep[j] = False
                else:
                    keep[i] = False
                    break

    return [l for l, k in zip(lines, keep) if k]


def _should_merge(a, b, angle_thr, gap_thr, perp_thr):
    """Check if two line segments are collinear/parallel and overlapping or close enough to merge."""
    len_a = _line_length(a)
    len_b = _line_length(b)
    if len_a < 1 or len_b < 1:
        return False

    # Angle check
    ang_a = _line_angle(a)
    ang_b = _line_angle(b)
    ang_diff = abs(ang_a - ang_b)
    if ang_diff > 90:
        ang_diff = 180 - ang_diff
    if ang_diff > angle_thr:
        return False

    # Perpendicular distance: check all 4 endpoints against the other line
    perp_b1 = _point_to_line_dist(b[0], b[1], a[0], a[1], a[2], a[3])
    perp_b2 = _point_to_line_dist(b[2], b[3], a[0], a[1], a[2], a[3])
    perp_a1 = _point_to_line_dist(a[0], a[1], b[0], b[1], b[2], b[3])
    perp_a2 = _point_to_line_dist(a[2], a[3], b[0], b[1], b[2], b[3])
    # Use the minimum perpendicular distance — if any endpoint is close to the
    # other line's axis, the lines are parallel and nearby
    min_perp = min(perp_b1, perp_b2, perp_a1, perp_a2)
    if min_perp > perp_thr:
        return False

    # Project both segments onto a common axis to check overlap or small gap
    ang = math.radians(ang_a)
    ux, uy = math.cos(ang), math.sin(ang)
    origin = (a[0], a[1])

    def proj(px, py):
        return (px - origin[0]) * ux + (py - origin[1]) * uy

    a_t1, a_t2 = proj(a[0], a[1]), proj(a[2], a[3])
    b_t1, b_t2 = proj(b[0], b[1]), proj(b[2], b[3])
    a_min, a_max = min(a_t1, a_t2), max(a_t1, a_t2)
    b_min, b_max = min(b_t1, b_t2), max(b_t1, b_t2)

    # Gap between projections (negative means overlap)
    gap = max(a_min, b_min) - min(a_max, b_max)
    if gap > gap_thr:
        return False

    return True


def _point_to_line_dist(px, py, x1, y1, x2, y2):
    """Perpendicular distance from point to infinite line through (x1,y1)-(x2,y2)."""
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy)
    if length < 1e-9:
        return math.hypot(px - x1, py - y1)
    return abs(dy * px - dx * py + x2 * y1 - y2 * x1) / length


def _merge_two(a, b):
    """Merge two collinear segments into one by taking the extreme endpoints."""
    ang = math.radians(_line_angle(a))
    ux, uy = math.cos(ang), math.sin(ang)
    origin = (a[0], a[1])
    pts = [(a[0], a[1]), (a[2], a[3]), (b[0], b[1]), (b[2], b[3])]
    projs = [(p[0] - origin[0]) * ux + (p[1] - origin[1]) * uy for p in pts]
    i_min = int(np.argmin(projs))
    i_max = int(np.argmax(projs))
    return [int(round(pts[i_min][0])), int(round(pts[i_min][1])),
            int(round(pts[i_max][0])), int(round(pts[i_max][1]))]


def _merge_collinear(lines, angle_thr, gap_thr, perp_thr):
    """Iteratively merge collinear segments until no more merges possible."""
    changed = True
    while changed:
        changed = False
        used = set()
        merged = []
        for i in range(len(lines)):
            if i in used:
                continue
            current = lines[i]
            for j in range(i + 1, len(lines)):
                if j in used:
                    continue
                if _should_merge(current, lines[j], angle_thr, gap_thr, perp_thr):
                    current = _merge_two(current, lines[j])
                    used.add(j)
                    changed = True
            merged.append(current)
            used.add(i)
        lines = merged
    return lines


@lines_bp.route('/session/<session_id>/lines/bulk-delete', methods=['POST'])
def bulk_delete_lines(session_id):
    """Delete multiple lines at once. Body: {items: [{type, idx}, ...]}"""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    body = request.get_json()
    items = body.get('items', [])
    if not items:
        return jsonify({'error': 'No items to delete'}), 400

    data = load_json_file(path)

    # Collect indices to remove per type, sort descending to preserve indices
    solid_to_remove = sorted([it['idx'] for it in items if it['type'] == 'solid'], reverse=True)
    dashed_to_remove = sorted([it['idx'] for it in items if it['type'] == 'dashed'], reverse=True)

    solid = data.get('solid', [])
    dashed = data.get('dashed', [])

    for idx in solid_to_remove:
        if 0 <= idx < len(solid):
            solid.pop(idx)
    for idx in dashed_to_remove:
        if 0 <= idx < len(dashed):
            dashed.pop(idx)

    data['solid'] = solid
    data['dashed'] = dashed
    # Reset directions since indices changed
    data['directions'] = {}

    save_json_file(path, data)

    return jsonify({
        'success': True,
        'num_solid': len(solid),
        'num_dashed': len(dashed),
    })


@lines_bp.route('/session/<session_id>/lines/save', methods=['POST'])
def save_lines(session_id):
    """Persist lines (already saved on each edit)."""
    return jsonify({'success': True})


@lines_bp.route('/session/<session_id>/lines/bulk', methods=['PUT'])
def bulk_update_lines(session_id):
    """Bulk update all lines data (for undo/redo)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_step4_lines.json')
    if not path:
        return jsonify({'error': 'No line data found'}), 404

    body = request.get_json()
    save_json_file(path, body)

    return jsonify({'success': True})
