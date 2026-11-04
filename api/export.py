"""Export API - download results, save them to the output folder, and graph editing"""
import os
import io
import shutil
import zipfile
from flask import Blueprint, request, jsonify, send_file
from config import UPLOAD_DIR, OUTPUT_DIR
from api.session_utils import (
    get_session_dir, find_file, load_json_file, save_json_file, get_image_stem, RESULT_SUFFIXES
)

export_bp = Blueprint('export', __name__)


@export_bp.route('/session/<session_id>/export/zip', methods=['GET'])
def export_zip(session_id):
    """Download all results as a ZIP file."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for fname in os.listdir(session_dir):
            if fname == 'session.json':
                continue
            fpath = os.path.join(session_dir, fname)
            if os.path.isfile(fpath):
                zf.write(fpath, fname)

    buf.seek(0)
    return send_file(
        buf,
        mimetype='application/zip',
        as_attachment=True,
        download_name=f'pnid_results_{session_id}.zip'
    )


@export_bp.route('/session/<session_id>/export/save', methods=['POST'])
def export_save(session_id):
    """Copy the session's result files (symbols, classification, text, lines, graph) to the
    configured output folder (PNID_OUTPUT_DIR). Returns the files written."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404
    if not OUTPUT_DIR:
        return jsonify({'error': 'No output folder configured (PNID_OUTPUT_DIR)'}), 400

    _sync_graph_with_symbols(session_dir)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    written = []
    for suffix in RESULT_SUFFIXES:
        path = find_file(session_dir, suffix)
        if path:
            dst = os.path.join(OUTPUT_DIR, os.path.basename(path))
            shutil.copy2(path, dst)
            written.append(os.path.basename(path))
    return jsonify({'success': True, 'output_dir': OUTPUT_DIR, 'files': written})


@export_bp.route('/session/<session_id>/export/graph', methods=['GET'])
def export_graph(session_id):
    """Get the digitized graph JSON, kept in step with the current symbol boxes and labels."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    data = _sync_graph_with_symbols(session_dir)
    if data is None:
        return jsonify({'error': 'No digitized graph found. Run digitization first.'}), 404
    return jsonify(data)


def _get_graph_path(session_dir):
    """Find the digitized graph JSON path (the full one, else the LLM one)."""
    path = find_file(session_dir, '_digitized.json')
    if not path:
        path = find_file(session_dir, '_digitized_llm.json')
    return path


def _sync_graph_with_symbols(session_dir):
    """Make the graph nodes match the symbol boxes (``_sam2_results.json``) and their labels
    (``_classification.json``): one node per box (new boxes get a node, deleted boxes lose theirs,
    bbox and category follow the editors), links kept while both ends exist.  Creates the graph file
    when the session has boxes but no graph yet.  Returns the graph data, or None when the session has
    no symbol file at all."""
    masks_path = find_file(session_dir, '_sam2_results.json')
    path = _get_graph_path(session_dir)
    if not masks_path:
        return load_json_file(path) if path else None

    masks = sorted(load_json_file(masks_path).get('masks_info', []), key=lambda m: m['id'])
    categories = {}
    cls_path = find_file(session_dir, '_classification.json')
    if cls_path:
        cls = load_json_file(cls_path) or {}
        for s in cls.get('symbols', []) + cls.get('discarded_symbols', []):
            categories[s.get('mask_id', s.get('id'))] = (s.get('category') or 'unlabeled', s.get('cluster_id'))

    if path and path.endswith('_digitized.json'):
        data = load_json_file(path) or {}
    else:
        stem = get_image_stem(session_dir) or os.path.basename(masks_path)[:-len('_sam2_results.json')]
        path = os.path.join(session_dir, f'{stem}_digitized.json')
        data = load_json_file(path) if os.path.exists(path) else {}
    nodes = data.get('nodes', []) or []
    links = data.get('links', []) or []

    changed = False
    by_mask = {}
    kept = []
    for n in nodes:
        mid = n.get('mask_id', n.get('id'))
        if mid in by_mask:          # duplicate node for one box
            changed = True
            continue
        by_mask[mid] = n
        kept.append(n)
    mask_ids = {m['id'] for m in masks}
    new_nodes = [n for n in kept if n.get('mask_id', n.get('id')) in mask_ids]
    if len(new_nodes) != len(kept):
        changed = True
    next_id = max([n['id'] for n in new_nodes], default=-1) + 1
    for m in masks:
        n = by_mask.get(m['id'])
        if n is None or n.get('mask_id', n.get('id')) not in mask_ids:
            cat, cid = categories.get(m['id'], ('unlabeled', None))
            new_nodes.append({'id': next_id, 'category': cat, 'bbox': m['bbox'], 'area': m.get('area'),
                              'captions': [], 'nearby_text_details': [], 'confidence': m.get('score'),
                              'cluster_id': cid, 'mask_id': m['id'], 'original_index': next_id})
            next_id += 1
            changed = True
            continue
        if n.get('bbox') != m['bbox']:
            n['bbox'] = m['bbox']; n['area'] = m.get('area'); changed = True
        if m['id'] in categories:
            cat, cid = categories[m['id']]
            if n.get('category') != cat or n.get('cluster_id') != cid:
                n['category'] = cat; n['cluster_id'] = cid; changed = True
        if 'mask_id' not in n:
            n['mask_id'] = m['id']; changed = True
    node_ids = {n['id'] for n in new_nodes}
    new_links = [l for l in links if l.get('source') in node_ids and l.get('target') in node_ids]
    if len(new_links) != len(links):
        changed = True

    data['nodes'] = new_nodes
    data['links'] = new_links
    meta = data.setdefault('metadata', {})
    if meta.get('total_symbols') != len(new_nodes) or meta.get('total_connections') != len(new_links):
        meta['total_symbols'] = len(new_nodes)
        meta['total_connections'] = len(new_links)
        changed = True
    if changed or not os.path.exists(path):
        save_json_file(path, data)
    return data


@export_bp.route('/session/<session_id>/graph/node/<int:node_id>', methods=['DELETE'])
def delete_graph_node(session_id, node_id):
    """Delete a node and all its connected links from the graph (the symbol box is kept)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = _get_graph_path(session_dir)
    if not path:
        return jsonify({'error': 'No graph found'}), 404

    data = load_json_file(path)
    nodes = data.get('nodes', [])
    links = data.get('links', [])

    orig_node_count = len(nodes)
    data['nodes'] = [n for n in nodes if n.get('id') != node_id]
    if len(data['nodes']) == orig_node_count:
        return jsonify({'error': f'Node {node_id} not found'}), 404

    # Remove links connected to this node
    data['links'] = [l for l in links if l.get('source') != node_id and l.get('target') != node_id]

    # Update metadata
    if 'metadata' in data:
        data['metadata']['total_symbols'] = len(data['nodes'])
        data['metadata']['total_connections'] = len(data['links'])

    save_json_file(path, data)
    return jsonify({'success': True, 'nodes': len(data['nodes']), 'links': len(data['links'])})


@export_bp.route('/session/<session_id>/graph/link', methods=['DELETE'])
def delete_graph_link(session_id):
    """Delete a link by source and target IDs."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = _get_graph_path(session_dir)
    if not path:
        return jsonify({'error': 'No graph found'}), 404

    body = request.get_json() or {}
    source_id = body.get('source')
    target_id = body.get('target')
    if source_id is None or target_id is None:
        return jsonify({'error': 'source and target are required'}), 400

    data = load_json_file(path)
    links = data.get('links', [])
    orig_count = len(links)
    data['links'] = [l for l in links if not ((l.get('source') == source_id and l.get('target') == target_id) or
                                             (l.get('source') == target_id and l.get('target') == source_id))]

    if len(data['links']) == orig_count:
        return jsonify({'error': 'Link not found'}), 404

    if 'metadata' in data:
        data['metadata']['total_connections'] = len(data['links'])

    save_json_file(path, data)
    return jsonify({'success': True, 'links': len(data['links'])})


@export_bp.route('/session/<session_id>/graph/bulk', methods=['PUT'])
def bulk_update_graph(session_id):
    """Bulk update graph data (for undo/redo)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = _get_graph_path(session_dir)
    if not path:
        return jsonify({'error': 'No graph found'}), 404

    body = request.get_json()
    data = load_json_file(path)
    data['nodes'] = body.get('nodes', data.get('nodes', []))
    data['links'] = body.get('links', data.get('links', []))
    if 'metadata' in data:
        data['metadata']['total_symbols'] = len(data['nodes'])
        data['metadata']['total_connections'] = len(data['links'])

    save_json_file(path, data)
    return jsonify({'success': True})


@export_bp.route('/session/<session_id>/graph/link', methods=['POST'])
def add_graph_link(session_id):
    """Add a new link between two nodes."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = _get_graph_path(session_dir)
    if not path:
        return jsonify({'error': 'No graph found'}), 404

    body = request.get_json() or {}
    source_id = body.get('source')
    target_id = body.get('target')
    if source_id is None or target_id is None:
        return jsonify({'error': 'source and target are required'}), 400
    if source_id == target_id:
        return jsonify({'error': 'Cannot create self-loop'}), 400

    data = load_json_file(path)
    nodes = data.get('nodes', [])
    links = data.get('links', [])

    node_ids = {n['id'] for n in nodes}
    if source_id not in node_ids:
        return jsonify({'error': f'Source node {source_id} not found'}), 404
    if target_id not in node_ids:
        return jsonify({'error': f'Target node {target_id} not found'}), 404

    # Check for duplicate (either direction: connections are undirected)
    for l in links:
        if {l.get('source'), l.get('target')} == {source_id, target_id}:
            return jsonify({'error': 'Link already exists'}), 409

    # Compute next link ID
    max_id = max((l.get('id', 0) for l in links), default=0)
    link_type = body.get('type', 'solid')
    direction = body.get('direction', 'none')

    new_link = {
        'id': max_id + 1,
        'source': source_id,
        'target': target_id,
        'type': link_type,
        'direction': direction,
    }
    data['links'].append(new_link)

    if 'metadata' in data:
        data['metadata']['total_connections'] = len(data['links'])

    save_json_file(path, data)
    return jsonify({'success': True, 'link': new_link, 'links': len(data['links'])})
