"""Export API - download results"""
import os
import io
import zipfile
from flask import Blueprint, request, jsonify, send_file
from config import UPLOAD_DIR
from api.session_utils import (
    get_session_dir, find_file, load_json_file
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
