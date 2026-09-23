"""Pipeline API - Run ML pipeline steps asynchronously"""
import os
import sys
import json
import uuid
import threading
import traceback
from flask import Blueprint, request, jsonify
from config import (
    UPLOAD_DIR, PNIDAGENT_DIR,
    YOLO_MODEL_PATH, SAM2_MODEL_PATH, SAM2_BASE_MODEL,
    LINE_SEG_MODEL_PATH, OCR_PYTHON,
    DEFAULT_DETECTOR, DEFAULT_CONFIDENCE, DEFAULT_DEVICE,
    DEFAULT_EMBEDDING_MODEL, DEFAULT_CLUSTERING_METHOD, DEFAULT_SENSITIVITY,
    DEFAULT_TARGET_WIDTH, DEFAULT_NMS_IOU, DEFAULT_MIN_LINE_LEN,
    DEFAULT_MAX_TEXT_DISTANCE, DEFAULT_MAX_LINE_DISTANCE,
    DEFAULT_LINE_SOURCE,
    DEFAULT_ASSEMBLER, DEFAULT_SNAP_TOL, DEFAULT_SYMBOL_PAD,
)
from api.session_utils import (
    get_session_dir, get_image_path, find_file, load_json_file,
    save_json_file, load_session_meta, save_session_meta
)

pipeline_bp = Blueprint('pipeline', __name__)

# Task tracking
tasks = {}


def _update_task(task_id, **kwargs):
    if task_id in tasks:
        tasks[task_id].update(kwargs)


@pipeline_bp.route('/task/<task_id>/status', methods=['GET'])
def task_status(task_id):
    """Poll async task status."""
    if task_id not in tasks:
        return jsonify({'error': 'Task not found'}), 404
    return jsonify(tasks[task_id])


@pipeline_bp.route('/session/<session_id>/run/detect', methods=['POST'])
def run_detection(session_id):
    """Run symbol detection (async)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    image_path = get_image_path(session_dir)
    if not image_path:
        return jsonify({'error': 'No image found in session'}), 404

    body = request.get_json() or {}
    detector = body.get('detector', DEFAULT_DETECTOR)
    confidence = body.get('confidence', DEFAULT_CONFIDENCE)
    device = body.get('device', DEFAULT_DEVICE)

    task_id = str(uuid.uuid4())[:12]
    tasks[task_id] = {'status': 'running', 'step': 'symbol_detection', 'progress': 'Starting...'}

    def run():
        try:
            import cv2
            import numpy as np
            from pathlib import Path

            img_name = Path(image_path).stem
            image = cv2.imread(image_path)
            if image is None:
                _update_task(task_id, status='error', error='Failed to load image')
                return

            results_json = os.path.join(session_dir, f'{img_name}_sam2_results.json')
            masks_output = os.path.join(session_dir, f'{img_name}_masks.npz')

            if detector == 'sam2':
                _update_task(task_id, progress='Loading SAM2 model...')
                from sam2_amg_inference import (
                    SAM2AutomaticMaskGenerator, save_combined_masks, save_results_json
                )
                mask_generator = SAM2AutomaticMaskGenerator(
                    model_path=SAM2_MODEL_PATH,
                    model_name=SAM2_BASE_MODEL,
                    device=device,
                    confidence_threshold=confidence
                )
                _update_task(task_id, progress='Generating masks...')
                masks_data = mask_generator.generate_automatic_masks(image)
                save_combined_masks(image, masks_data, session_dir, img_name)

                processing_params = {
                    'confidence_threshold': confidence,
                    'prompt_type': 'points',
                    'detector': 'sam2'
                }
                save_results_json(masks_data, results_json, image_path, processing_params)

            else:  # YOLO
                _update_task(task_id, progress='Loading YOLO model...')
                from finetune_yolo_symbols import YOLOSymbolDetector
                yolo_detector = YOLOSymbolDetector(model_path=YOLO_MODEL_PATH)

                _update_task(task_id, progress='Running detection...')
                detections = yolo_detector.detect(image, conf_threshold=confidence)

                masks = []
                scores = []
                masks_info = []
                h, w = image.shape[:2]

                for i, det in enumerate(detections):
                    mask = np.zeros((h, w), dtype=bool)
                    x1, y1, x2, y2 = [int(v) for v in det.bbox]
                    x1, y1 = max(0, x1), max(0, y1)
                    x2, y2 = min(w, x2), min(h, y2)
                    mask[y1:y2, x1:x2] = True
                    masks.append(mask)
                    scores.append(det.confidence)
                    area = (x2 - x1) * (y2 - y1)
                    masks_info.append({
                        'id': i,
                        'score': float(det.confidence),
                        'area': int(area),
                        'bbox': [x1, y1, x2, y2],
                        'center': [int(det.x_center), int(det.y_center)]
                    })

                np.savez_compressed(
                    masks_output,
                    masks=np.array(masks) if masks else np.array([]),
                    scores=np.array(scores) if scores else np.array([]),
                    image_shape=image.shape,
                    num_masks=len(masks)
                )

                results = {
                    'image_path': str(image_path),
                    'num_masks': len(masks),
                    'processing_params': {
                        'confidence_threshold': confidence,
                        'detector': 'yolo',
                        'model_path': YOLO_MODEL_PATH
                    },
                    'masks_info': masks_info
                }
                save_json_file(results_json, results)

            # Update session metadata
            meta = load_session_meta(session_id)
            if meta:
                meta['steps_complete']['symbol_detection'] = True
                save_session_meta(session_id, meta)

            _update_task(task_id, status='complete', progress='Done')

        except Exception as e:
            _update_task(task_id, status='error', error=str(e),
                        traceback=traceback.format_exc())

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    return jsonify({'task_id': task_id})


@pipeline_bp.route('/session/<session_id>/run/text-lines', methods=['POST'])
def run_text_lines(session_id):
    """Run text and line detection (async)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    image_path = get_image_path(session_dir)
    if not image_path:
        return jsonify({'error': 'No image found'}), 404

    body = request.get_json() or {}
    target_width = body.get('target_width', DEFAULT_TARGET_WIDTH)
    line_source = body.get('line_source', DEFAULT_LINE_SOURCE)
    if line_source not in ('unet', 'classical'):
        return jsonify({'error': f'Unknown line_source: {line_source}'}), 400

    task_id = str(uuid.uuid4())[:12]
    tasks[task_id] = {'status': 'running', 'step': 'text_lines', 'progress': 'Starting...'}

    def run():
        try:
            from pathlib import Path
            img_name = Path(image_path).stem
            lines_json = os.path.join(session_dir, f'{img_name}_step4_lines.json')

            _update_task(task_id, progress='Running text and line detection...')

            # Use subprocess to call process_text_lines.py. PaddleOCR needs its own
            # environment (it pins opencv 4.6, and paddlepaddle-gpu downgrades the
            # nccl/cudnn torch needs), so allow a separate interpreter.
            import subprocess
            cmd = [
                OCR_PYTHON or sys.executable,
                os.path.join(PNIDAGENT_DIR, 'process_text_lines.py'),
                '--image', image_path,
                '--out', session_dir,
                '--target-width', str(target_width),
                '--lang', 'en',
                '--nms-iou', str(DEFAULT_NMS_IOU),
                '--suppress-text',
                '--line-method', line_source,
            ]
            # The U-Net needs torch, which the OCR environment may not have. This
            # interpreter does, so name it as the one to run the U-Net in; the
            # pipeline only uses it if importing torch in-process fails.
            if OCR_PYTHON:
                cmd += ['--line-python', sys.executable]
            if LINE_SEG_MODEL_PATH and os.path.exists(LINE_SEG_MODEL_PATH):
                cmd += ['--line-ckpt', LINE_SEG_MODEL_PATH]

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

            if result.returncode != 0:
                _update_task(task_id, status='error',
                            error=f'Process failed: {result.stderr[-500:]}')
                return

            # The pipeline falls back to the classical stage on its own if torch or
            # the checkpoint is missing, and records what actually ran. Surface that
            # rather than assuming the requested method is the one we got.
            used_source = (load_json_file(lines_json) or {}).get('method') or line_source
            warning = None
            if line_source == 'unet' and not used_source.startswith('unet'):
                warning = (f'U-Net unavailable, fell back to {used_source} lines. '
                           f'Check that torch is installed and {LINE_SEG_MODEL_PATH} exists.')

            meta = load_session_meta(session_id)
            if meta:
                meta['steps_complete']['text_detection'] = True
                meta['steps_complete']['line_detection'] = True
                meta['line_source'] = used_source
                save_session_meta(session_id, meta)

            _update_task(task_id, status='complete', progress='Done',
                         line_source=used_source, warning=warning)

        except Exception as e:
            _update_task(task_id, status='error', error=str(e),
                        traceback=traceback.format_exc())

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    return jsonify({'task_id': task_id})


@pipeline_bp.route('/session/<session_id>/run/classify', methods=['POST'])
def run_classify(session_id):
    """Run auto-classification (embedding + clustering)."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    body = request.get_json() or {}
    embedding_model = body.get('embedding_model', DEFAULT_EMBEDDING_MODEL)
    clustering_method = body.get('clustering_method', DEFAULT_CLUSTERING_METHOD)
    sensitivity = body.get('sensitivity', DEFAULT_SENSITIVITY)
    device = body.get('device', DEFAULT_DEVICE)

    results_json = find_file(session_dir, '_sam2_results.json')
    if not results_json:
        return jsonify({'error': 'Run symbol detection first'}), 400

    task_id = str(uuid.uuid4())[:12]
    tasks[task_id] = {'status': 'running', 'step': 'classification', 'progress': 'Starting...'}

    def run():
        try:
            import cv2
            import numpy as np
            from pathlib import Path

            # Import classification functions from PnIDAgent
            from interactive_symbol_classifier import (
                SymbolEmbedder, SymbolClusterer, save_classification_results
            )

            # Load SAM2 results (authoritative after user edits)
            _update_task(task_id, progress='Loading detection results...')
            with open(results_json, 'r') as f:
                sam_results = json.load(f)

            masks_info = sam_results.get('masks_info', [])
            if not masks_info:
                _update_task(task_id, status='error', error='No masks found in results')
                return

            image_path = get_image_path(session_dir)
            if not image_path:
                _update_task(task_id, status='error', error='No image found')
                return

            image = cv2.imread(image_path)
            if image is None:
                _update_task(task_id, status='error', error='Failed to load image')
                return

            # Extract patches directly from edited masks_info bboxes
            # (not from NPZ, which may have stale index-to-id mapping)
            _update_task(task_id, progress='Extracting symbol patches...')
            h, w = image.shape[:2]
            patches = []
            patches_metadata = []
            padding = 5

            for m in masks_info:
                x1, y1, x2, y2 = m['bbox']
                x1p = max(0, x1 - padding)
                y1p = max(0, y1 - padding)
                x2p = min(w, x2 + padding)
                y2p = min(h, y2 + padding)

                patch = image[y1p:y2p, x1p:x2p].copy()
                if patch.shape[0] < 5 or patch.shape[1] < 5:
                    continue

                patches.append(patch)
                patches_metadata.append({
                    'mask_id': m['id'],
                    'bbox': [int(x1p), int(y1p), int(x2p), int(y2p)],
                    'size': [int(x2p - x1p), int(y2p - y1p)],
                    'area': m.get('area', (x2 - x1) * (y2 - y1)),
                })

            if len(patches) == 0:
                _update_task(task_id, status='error', error='No valid patches extracted')
                return

            # Generate embeddings
            _update_task(task_id, progress=f'Generating embeddings for {len(patches)} symbols...')
            embedder = SymbolEmbedder(model_type=embedding_model, device=device)
            embeddings = embedder.extract_embeddings(patches, batch_size=32)

            # Cluster
            _update_task(task_id, progress='Clustering symbols...')
            clusterer = SymbolClusterer(method=clustering_method, sensitivity=sensitivity)
            cluster_labels = clusterer.fit(embeddings)

            # Create default label names (unknown for each cluster)
            unique_clusters = sorted(set(cluster_labels))
            label_names = {c: f'cluster_{c}' for c in unique_clusters if c >= 0}
            if -1 in unique_clusters:
                label_names[-1] = 'noise'

            # Save results
            _update_task(task_id, progress='Saving classification...')
            img_stem = Path(image_path).stem
            classification_path = os.path.join(session_dir, f'{img_stem}_classification.json')
            save_classification_results(
                image_path, patches_metadata, cluster_labels,
                label_names, embeddings, classification_path
            )

            meta = load_session_meta(session_id)
            if meta:
                meta['steps_complete']['classification'] = True
                save_session_meta(session_id, meta)

            _update_task(task_id, status='complete', progress='Done')

        except Exception as e:
            _update_task(task_id, status='error', error=str(e),
                        traceback=traceback.format_exc())

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    return jsonify({'task_id': task_id})


@pipeline_bp.route('/session/<session_id>/run/digitize', methods=['POST'])
def run_digitize(session_id):
    """Run final digitization."""
    session_dir = get_session_dir(session_id)
    if not session_dir:
        return jsonify({'error': 'Session not found'}), 404

    body = request.get_json() or {}
    max_text_distance = body.get('max_text_distance', DEFAULT_MAX_TEXT_DISTANCE)
    max_line_distance = body.get('max_line_distance', DEFAULT_MAX_LINE_DISTANCE)
    assembler = body.get('assembler', DEFAULT_ASSEMBLER)
    snap_tol = body.get('snap_tol', DEFAULT_SNAP_TOL)
    symbol_pad = body.get('symbol_pad', DEFAULT_SYMBOL_PAD)

    classification_path = find_file(session_dir, '_classification.json')
    text_path = find_file(session_dir, '_step3_text.json')
    lines_path = find_file(session_dir, '_step4_lines.json')
    sam2_path = find_file(session_dir, '_sam2_results.json')

    if not lines_path or not text_path:
        return jsonify({'error': 'Run text and line detection first'}), 400
    if not classification_path and not sam2_path:
        return jsonify({'error': 'Run symbol detection first'}), 400

    from pathlib import Path
    img_stem = Path(get_image_path(session_dir) or '').stem or 'result'

    # Classification is produced by the interactive classifier, so a user who goes
    # straight from detection to digitization has none. Synthesize one from the
    # detector boxes instead of refusing: symbol boxes are in original-image
    # pixels while text and lines are in the resized space, so scale by the factor
    # the line stage recorded rather than letting digitize_pnid guess it from
    # coordinate magnitudes.
    if not classification_path:
        det = load_json_file(sam2_path) or {}
        scale = float((load_json_file(lines_path) or {}).get('scale') or 1.0)
        syms = [{'id': m['id'], 'mask_id': m['id'],
                 'bbox': [int(round(v * scale)) for v in m['bbox']],
                 'bbox_scaled': scale != 1.0,
                 'category': 'symbol', 'confidence': m.get('score')}
                for m in det.get('masks_info', []) if m.get('bbox')]
        classification_path = os.path.join(session_dir, f'{img_stem}_classification.json')
        save_json_file(classification_path,
                       {'symbols': syms, 'source': 'detector', 'scale': scale})
        # results_json boxes are unscaled, so do not let them override the scaled ones
        sam2_path = None

    try:
        from digitize_pnid import digitize_pnid as digitize_func

        full_json, llm_json = digitize_func(
            classification_path=classification_path,
            text_path=text_path,
            lines_path=lines_path,
            sam2_path=sam2_path,
            max_text_distance=max_text_distance,
            max_line_distance=max_line_distance,
            assembler=assembler,
            snap_tol=snap_tol,
            symbol_pad=symbol_pad,
        )

        full_path = os.path.join(session_dir, f'{img_stem}_digitized.json')
        llm_path = os.path.join(session_dir, f'{img_stem}_digitized_llm.json')

        save_json_file(full_path, full_json)
        save_json_file(llm_path, llm_json)

        meta = load_session_meta(session_id)
        if meta:
            meta['steps_complete']['digitization'] = True
            save_session_meta(session_id, meta)

        nodes = full_json.get('nodes', [])
        return jsonify({
            'success': True,
            'nodes': len(nodes),
            'links': len(full_json.get('links', [])),
            'junctions': sum(1 for n in nodes if n.get('category') == 'junction'),
            'symbols': sum(1 for n in nodes if n.get('category') != 'junction'),
            'assembler': assembler,
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500
