"""Export API - download results and graph editing"""
import os
import io
import zipfile
from flask import Blueprint, request, jsonify, send_file
from config import UPLOAD_DIR
from api.session_utils import (
    get_session_dir, find_file, load_json_file, save_json_file
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


@export_bp.route('/session/<session_id>/export/graph', methods=['GET'])
def export_graph(session_id):
    """Get digitized graph JSON."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    # Use full JSON (has bbox, cluster_id, mask_id for visualization)
    path = find_file(session_dir, '_digitized.json')
    if not path:
        path = find_file(session_dir, '_digitized_llm.json')
    if not path:
        return jsonify({'error': 'No digitized graph found. Run digitization first.'}), 404

    data = load_json_file(path)
    return jsonify(data)


def _get_graph_path(session_dir):
    """Find the digitized graph JSON path."""
    path = find_file(session_dir, '_digitized.json')
    if not path:
        path = find_file(session_dir, '_digitized_llm.json')
    return path


@export_bp.route('/session/<session_id>/graph/node/<int:node_id>', methods=['DELETE'])
def delete_graph_node(session_id, node_id):
    """Delete a node and all its connected links from the graph."""
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
    data['links'] = [l for l in links if not (l.get('source') == source_id and l.get('target') == target_id)]

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

    # Check for duplicate
    for l in links:
        if l.get('source') == source_id and l.get('target') == target_id:
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
