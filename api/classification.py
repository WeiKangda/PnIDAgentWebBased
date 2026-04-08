"""Classification Editor API"""
import os
import json
from flask import Blueprint, request, jsonify
from config import UPLOAD_DIR
from api.session_utils import (
    get_session_dir, find_file, load_json_file, save_json_file
)

classification_bp = Blueprint('classification', __name__)


@classification_bp.route('/session/<session_id>/classification', methods=['GET'])
def get_classification(session_id):
    """Get classification data (clusters and labels)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_classification.json')
    if not path:
        return jsonify({'error': 'No classification data found'}), 404

    data = load_json_file(path)

    # Include all symbols (both valid and discarded) — user has already edited masks
    symbols = data.get('symbols', []) + data.get('discarded_symbols', [])
    clusters = {}
    for sym in symbols:
        cid = sym.get('cluster_id', 0)
        cat = sym.get('category', 'Unknown')
        if cid not in clusters:
            clusters[cid] = {'id': cid, 'label': cat, 'symbol_ids': []}
        # Use mask_id for patch fetching (matches masks API endpoint)
        clusters[cid]['symbol_ids'].append(sym.get('mask_id', sym['id']))

    # Strip embeddings from response (too large)
    symbols_stripped = []
    for sym in symbols:
        s = {k: v for k, v in sym.items() if k != 'embedding'}
        symbols_stripped.append(s)

    # Sort clusters by ID so cluster_0 is first, cluster_1 second, etc.
    sorted_clusters = sorted(clusters.values(), key=lambda c: c['id'])

    return jsonify({
        'num_symbols': len(symbols),
        'num_clusters': len(clusters),
        'categories': data.get('categories', {}),
        'clusters': sorted_clusters,
        'symbols': symbols_stripped,
    })


@classification_bp.route('/session/<session_id>/classification/clusters/<int:cid>/label',
                         methods=['PUT'])
def set_cluster_label(session_id, cid):
    """Set label for a cluster."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_classification.json')
    if not path:
        return jsonify({'error': 'No classification data found'}), 404

    body = request.get_json()
    label = body.get('label', '').strip()
    if not label:
        return jsonify({'error': 'Label is required'}), 400

    data = load_json_file(path)
    symbols = data.get('symbols', []) + data.get('discarded_symbols', [])

    # Update all symbols in this cluster
    old_label = None
    for sym in symbols:
        if sym.get('cluster_id') == cid:
            old_label = sym.get('category')
            sym['category'] = label

    # Update categories count
    categories = {}
    for sym in symbols:
        cat = sym.get('category', 'Unknown')
        categories[cat] = categories.get(cat, 0) + 1
    data['categories'] = categories
    data['symbols'] = symbols
    data['discarded_symbols'] = []

    save_json_file(path, data)

    return jsonify({'success': True, 'old_label': old_label, 'new_label': label})


@classification_bp.route('/session/<session_id>/classification/move', methods=['POST'])
def move_symbols(session_id):
    """Move symbols to a different cluster."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_classification.json')
    if not path:
        return jsonify({'error': 'No classification data found'}), 404

    body = request.get_json()
    symbol_ids = body.get('symbol_ids', [])
    target_cluster_id = body.get('target_cluster_id')
    target_label = body.get('target_label', '')

    if not symbol_ids:
        return jsonify({'error': 'symbol_ids is required'}), 400

    data = load_json_file(path)
    symbols = data.get('symbols', []) + data.get('discarded_symbols', [])

    ids_set = set(symbol_ids)

    # If target_cluster_id is None, create a new cluster
    if target_cluster_id is None:
        existing_cids = set(s.get('cluster_id', 0) for s in symbols)
        target_cluster_id = max(existing_cids) + 1 if existing_cids else 0

    for sym in symbols:
        # Match by mask_id (used by frontend) or fall back to id
        sym_key = sym.get('mask_id', sym['id'])
        if sym_key in ids_set:
            sym['cluster_id'] = target_cluster_id
            if target_label:
                sym['category'] = target_label

    # Update categories
    categories = {}
    for sym in symbols:
        cat = sym.get('category', 'Unknown')
        categories[cat] = categories.get(cat, 0) + 1
    data['categories'] = categories
    data['num_clusters'] = len(set(s.get('cluster_id', 0) for s in symbols))
    data['symbols'] = symbols
    data['discarded_symbols'] = []

    save_json_file(path, data)

    return jsonify({'success': True, 'target_cluster_id': target_cluster_id})


@classification_bp.route('/session/<session_id>/classification/clusters/<int:cid>/discard',
                         methods=['POST'])
def discard_cluster(session_id, cid):
    """Discard a cluster — removes symbols from classification and deletes their masks."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_classification.json')
    if not path:
        return jsonify({'error': 'No classification data found'}), 404

    data = load_json_file(path)
    all_symbols = data.get('symbols', []) + data.get('discarded_symbols', [])

    # Separate: symbols in this cluster vs rest
    discarded = [s for s in all_symbols if s.get('cluster_id') == cid]
    remaining = [s for s in all_symbols if s.get('cluster_id') != cid]

    if not discarded:
        return jsonify({'error': f'No symbols found in cluster {cid}'}), 404

    # Collect mask_ids to remove from symbol detection results
    mask_ids_to_remove = set()
    for s in discarded:
        mid = s.get('mask_id', s.get('id'))
        if mid is not None:
            mask_ids_to_remove.add(mid)

    # Update classification JSON — put all remaining in 'symbols', clear 'discarded_symbols'
    data['symbols'] = remaining
    data['discarded_symbols'] = []

    # Update categories
    categories = {}
    for sym in remaining:
        cat = sym.get('category', 'Unknown')
        categories[cat] = categories.get(cat, 0) + 1
    data['categories'] = categories
    data['num_clusters'] = len(set(s.get('cluster_id', 0) for s in remaining))
    data['num_symbols_valid'] = len(remaining)

    save_json_file(path, data)

    # Remove masks from sam2_results.json
    results_path = find_file(session_dir, '_sam2_results.json')
    if results_path:
        results_data = load_json_file(results_path)
        masks_info = results_data.get('masks_info', [])
        masks_info = [m for m in masks_info if m['id'] not in mask_ids_to_remove]
        results_data['masks_info'] = masks_info
        results_data['num_masks'] = len(masks_info)
        save_json_file(results_path, results_data)

        # Re-sync NPZ
        from api.masks import _sync_masks_npz
        _sync_masks_npz(session_dir, masks_info)

    return jsonify({
        'success': True,
        'discarded_count': len(discarded),
        'remaining_symbols': len(remaining),
        'removed_mask_ids': list(mask_ids_to_remove),
    })


@classification_bp.route('/session/<session_id>/classification/delete-symbols', methods=['POST'])
def delete_symbols(session_id):
    """Delete specific symbols by mask_id from classification and masks data."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    path = find_file(session_dir, '_classification.json')
    if not path:
        return jsonify({'error': 'No classification data found'}), 404

    body = request.get_json()
    symbol_ids = body.get('symbol_ids', [])
    if not symbol_ids:
        return jsonify({'error': 'symbol_ids is required'}), 400

    ids_set = set(symbol_ids)

    # Remove from classification JSON
    data = load_json_file(path)
    all_symbols = data.get('symbols', []) + data.get('discarded_symbols', [])

    remaining = [s for s in all_symbols if s.get('mask_id', s.get('id')) not in ids_set]
    removed_count = len(all_symbols) - len(remaining)

    data['symbols'] = remaining
    data['discarded_symbols'] = []

    # Update categories
    categories = {}
    for sym in remaining:
        cat = sym.get('category', 'Unknown')
        categories[cat] = categories.get(cat, 0) + 1
    data['categories'] = categories
    data['num_clusters'] = len(set(s.get('cluster_id', 0) for s in remaining))
    data['num_symbols_valid'] = len(remaining)

    save_json_file(path, data)

    # Remove corresponding masks from sam2_results.json
    results_path = find_file(session_dir, '_sam2_results.json')
    if results_path:
        results_data = load_json_file(results_path)
        masks_info = results_data.get('masks_info', [])
        masks_info = [m for m in masks_info if m['id'] not in ids_set]
        results_data['masks_info'] = masks_info
        results_data['num_masks'] = len(masks_info)
        save_json_file(results_path, results_data)

        # Re-sync NPZ
        from api.masks import _sync_masks_npz
        _sync_masks_npz(session_dir, masks_info)

    return jsonify({
        'success': True,
        'removed_count': removed_count,
        'remaining_symbols': len(remaining),
    })


@classification_bp.route('/session/<session_id>/classification/auto-label', methods=['POST'])
def auto_label(session_id):
    """Auto-label clusters using CLIP embedding similarity against reference symbol images."""
    import cv2
    import numpy as np
    import sys
    from pathlib import Path
    from config import SYMBOLS_DIR, PNIDAGENT_DIR

    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    cls_path = find_file(session_dir, '_classification.json')
    if not cls_path:
        return jsonify({'error': 'No classification data found'}), 404

    body = request.get_json() or {}
    threshold = body.get('threshold', 0.65)  # Cosine similarity threshold (higher=stricter)
    symbol_set = body.get('symbol_set', None)

    # Load reference symbol images as cv2 patches
    ref_images = _load_reference_images(SYMBOLS_DIR, symbol_set)
    if not ref_images:
        return jsonify({'error': f'No reference symbols found in {SYMBOLS_DIR}'}), 404

    # Load classification data (has stored CLIP embeddings per symbol)
    data = load_json_file(cls_path)
    all_symbols = data.get('symbols', []) + data.get('discarded_symbols', [])

    # Check if symbols have embeddings
    has_embeddings = any(sym.get('embedding') for sym in all_symbols)

    # Import SymbolEmbedder to compute reference embeddings
    if PNIDAGENT_DIR not in sys.path:
        sys.path.insert(0, PNIDAGENT_DIR)
    from interactive_symbol_classifier import SymbolEmbedder

    embedding_model = body.get('embedding_model', 'clip')
    device = body.get('device', 'cpu')
    embedder = SymbolEmbedder(model_type=embedding_model, device=device)

    # Compute embeddings for reference images
    ref_patches = [img for _, img in ref_images]
    ref_names = [name for name, _ in ref_images]
    ref_embeddings = embedder.extract_embeddings(ref_patches, batch_size=16)  # (N_ref, dim)

    # If symbols don't have embeddings, compute from image patches
    if not has_embeddings:
        from api.session_utils import get_image_path
        image_path = get_image_path(session_dir)
        if not image_path:
            return jsonify({'error': 'No image found'}), 404
        image = cv2.imread(image_path)
        if image is None:
            return jsonify({'error': 'Failed to load image'}), 500
        h, w = image.shape[:2]

        sym_patches = []
        sym_indices = []
        for i, sym in enumerate(all_symbols):
            bbox = sym.get('bbox')
            if not bbox:
                continue
            x1, y1, x2, y2 = bbox
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            patch = image[y1:y2, x1:x2]
            if patch.size > 0 and patch.shape[0] >= 5 and patch.shape[1] >= 5:
                sym_patches.append(patch)
                sym_indices.append(i)

        if sym_patches:
            sym_embeddings = embedder.extract_embeddings(sym_patches, batch_size=32)
            for j, idx in enumerate(sym_indices):
                all_symbols[idx]['embedding'] = sym_embeddings[j].tolist()

    # Group symbols by cluster_id
    clusters = {}
    for sym in all_symbols:
        cid = sym.get('cluster_id', 0)
        if cid not in clusters:
            clusters[cid] = []
        clusters[cid].append(sym)

    labeled = 0
    results = []

    for cid, syms in clusters.items():
        # Collect embeddings for this cluster
        cluster_embeddings = []
        for sym in syms:
            emb = sym.get('embedding')
            if emb:
                cluster_embeddings.append(np.array(emb, dtype=np.float32))

        if not cluster_embeddings:
            results.append({'cluster_id': cid, 'label': None, 'score': 0, 'best_candidate': None})
            continue

        # Average embedding for the cluster (centroid)
        cluster_centroid = np.mean(cluster_embeddings, axis=0)
        cluster_centroid = cluster_centroid / (np.linalg.norm(cluster_centroid) + 1e-8)

        # Cosine similarity against all reference embeddings
        similarities = ref_embeddings @ cluster_centroid  # (N_ref,)

        best_idx = int(np.argmax(similarities))
        best_score = float(similarities[best_idx])
        best_label = ref_names[best_idx]

        if best_score >= threshold:
            for sym in syms:
                sym['category'] = best_label
            labeled += 1
            results.append({'cluster_id': cid, 'label': best_label, 'score': round(best_score, 4)})
        else:
            results.append({'cluster_id': cid, 'label': None,
                           'score': round(best_score, 4), 'best_candidate': best_label})

    # Save updated classification
    data['symbols'] = all_symbols
    data['discarded_symbols'] = []
    categories = {}
    for sym in all_symbols:
        cat = sym.get('category', 'Unknown')
        categories[cat] = categories.get(cat, 0) + 1
    data['categories'] = categories
    save_json_file(cls_path, data)

    return jsonify({
        'success': True,
        'labeled_clusters': labeled,
        'total_clusters': len(clusters),
        'details': results,
    })


def _load_reference_images(symbols_dir, symbol_set=None):
    """Load reference symbol images from the symbols directory.
    Returns list of (category_name, cv2_image_bgr) tuples.
    """
    import cv2
    import numpy as np

    if not os.path.isdir(symbols_dir):
        return []

    refs = []
    search_dirs = []
    if symbol_set:
        target = os.path.join(symbols_dir, symbol_set)
        if os.path.isdir(target):
            search_dirs = [target]
    else:
        for entry in os.listdir(symbols_dir):
            full = os.path.join(symbols_dir, entry)
            if os.path.isdir(full):
                search_dirs.append(full)
        search_dirs.append(symbols_dir)

    for d in search_dirs:
        for fname in os.listdir(d):
            if not fname.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff')):
                continue
            fpath = os.path.join(d, fname)
            category = os.path.splitext(fname)[0]

            # Read as BGR (convert RGBA if needed)
            img = cv2.imread(fpath, cv2.IMREAD_UNCHANGED)
            if img is None:
                continue

            if img.ndim == 3 and img.shape[2] == 4:
                # RGBA: composite onto white background using alpha
                alpha = img[:, :, 3:4].astype(float) / 255.0
                bgr = img[:, :, :3].astype(float)
                white = np.full_like(bgr, 255.0)
                img = (bgr * alpha + white * (1 - alpha)).astype(np.uint8)
            elif img.ndim == 2:
                img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)

            # If same category from multiple sets, keep all (they add diversity)
            refs.append((category, img))

    return refs


@classification_bp.route('/session/<session_id>/classification/symbol-sets', methods=['GET'])
def get_symbol_sets(session_id):
    """List available symbol reference sets."""
    from config import SYMBOLS_DIR
    if not os.path.isdir(SYMBOLS_DIR):
        return jsonify({'sets': []})

    sets = []
    for entry in sorted(os.listdir(SYMBOLS_DIR)):
        full = os.path.join(SYMBOLS_DIR, entry)
        if os.path.isdir(full):
            count = len([f for f in os.listdir(full)
                        if f.lower().endswith(('.png', '.jpg', '.jpeg', '.bmp'))])
            if count > 0:
                sets.append({'name': entry, 'count': count})

    return jsonify({'sets': sets})


@classification_bp.route('/session/<session_id>/classification/save', methods=['POST'])
def save_classification(session_id):
    """Persist classification (already saved on each edit)."""
    return jsonify({'success': True})
