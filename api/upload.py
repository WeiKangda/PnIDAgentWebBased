"""Upload API - handle image and ZIP uploads"""
import os
import uuid
import json
import shutil
import zipfile
import threading
from datetime import datetime
from pathlib import Path
from flask import Blueprint, request, jsonify
from config import UPLOAD_DIR, ALLOWED_IMAGE_EXTENSIONS
from api.session_utils import get_image_path, find_file


def _convert_pdf_page_to_png(pdf_path, output_dir, stem, page_num=0):
    """Convert a single PDF page to PNG. Returns path to the output image."""
    import fitz  # PyMuPDF

    doc = fitz.open(pdf_path)
    if len(doc) == 0:
        raise ValueError('PDF has no pages')
    if page_num >= len(doc):
        raise ValueError(f'Page {page_num + 1} does not exist (PDF has {len(doc)} pages)')

    page = doc[page_num]
    # 300 DPI for good quality
    mat = fitz.Matrix(300 / 72, 300 / 72)
    pix = page.get_pixmap(matrix=mat)

    png_path = os.path.join(output_dir, f'{stem}.png')
    pix.save(png_path)
    doc.close()

    return png_path


def _get_pdf_info(pdf_path, max_thumbnails=20):
    """Get PDF page count and generate thumbnail data URIs for each page."""
    import fitz  # PyMuPDF
    import base64

    doc = fitz.open(pdf_path)
    num_pages = len(doc)
    thumbnails = []

    # Only generate thumbnails for first max_thumbnails pages to avoid timeout
    for i in range(min(num_pages, max_thumbnails)):
        page = doc[i]
        # Very low-res thumbnail for speed
        mat = fitz.Matrix(0.15, 0.15)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes('png')
        b64 = base64.b64encode(img_bytes).decode('ascii')
        thumbnails.append({
            'page': i,
            'width': pix.width,
            'height': pix.height,
            'thumbnail': f'data:image/png;base64,{b64}',
        })

    doc.close()
    return num_pages, thumbnails

upload_bp = Blueprint('upload', __name__)


def _create_session(image_name, image_stem):
    """Create a new session directory and metadata."""
    session_id = str(uuid.uuid4())[:12]
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    meta = {
        'id': session_id,
        'created': datetime.now().isoformat(),
        'image_name': image_name,
        'image_stem': image_stem,
        'steps_complete': {
            'symbol_detection': False,
            'classification': False,
            'text_detection': False,
            'line_detection': False,
            'digitization': False,
        }
    }

    with open(os.path.join(session_dir, 'session.json'), 'w') as f:
        json.dump(meta, f, indent=2)

    return session_id, session_dir, meta


def _detect_completed_steps(session_dir):
    """Detect which pipeline steps have already been completed based on files present."""
    steps = {
        'symbol_detection': False,
        'classification': False,
        'text_detection': False,
        'line_detection': False,
        'digitization': False,
    }

    if find_file(session_dir, '_sam2_results.json'):
        steps['symbol_detection'] = True
    if find_file(session_dir, '_classification.json'):
        steps['classification'] = True
    if find_file(session_dir, '_step3_text.json'):
        steps['text_detection'] = True
    if find_file(session_dir, '_step4_lines.json'):
        steps['line_detection'] = True
    if find_file(session_dir, '_digitized.json'):
        steps['digitization'] = True

    return steps


@upload_bp.route('/upload/image', methods=['POST'])
def upload_image():
    """Upload a P&ID image to start a new session."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    ext = Path(f.filename).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return jsonify({'error': f'Invalid file type: {ext}. Allowed: {ALLOWED_IMAGE_EXTENSIONS}'}), 400

    stem = Path(f.filename).stem
    session_id, session_dir, meta = _create_session(f.filename, stem)

    # Save the uploaded file
    image_path = os.path.join(session_dir, f.filename)
    f.save(image_path)

    # Handle PDF: check page count
    if ext == '.pdf':
        try:
            import fitz
            doc = fitz.open(image_path)
            num_pages = len(doc)
            doc.close()
        except Exception as e:
            shutil.rmtree(session_dir)
            return jsonify({'error': f'Failed to read PDF: {str(e)}'}), 400

        if num_pages > 1:
            # Multi-page: generate thumbnails and return page selection
            try:
                _, thumbnails = _get_pdf_info(image_path)
            except Exception as e:
                shutil.rmtree(session_dir)
                return jsonify({'error': f'Failed to read PDF: {str(e)}'}), 400
            return jsonify({
                'session_id': session_id,
                'mode': 'pdf_select',
                'num_pages': num_pages,
                'thumbnails': thumbnails,
            })
        else:
            # Single page: convert in background, return immediately
            image_name = f'{stem}.png'
            meta['image_name'] = image_name
            meta['pdf_converting'] = True
            with open(os.path.join(session_dir, 'session.json'), 'w') as mf:
                json.dump(meta, mf, indent=2)

            def _bg_convert(pdf_path, out_dir, file_stem, session_dir):
                try:
                    _convert_pdf_page_to_png(pdf_path, out_dir, file_stem, 0)
                    os.remove(pdf_path)
                    # Mark conversion done
                    meta_path = os.path.join(session_dir, 'session.json')
                    with open(meta_path, 'r') as mf:
                        m = json.load(mf)
                    m.pop('pdf_converting', None)
                    with open(meta_path, 'w') as mf:
                        json.dump(m, mf, indent=2)
                except Exception:
                    pass

            threading.Thread(
                target=_bg_convert,
                args=(image_path, session_dir, stem, session_dir),
                daemon=True,
            ).start()
    else:
        image_name = f.filename

    return jsonify({
        'session_id': session_id,
        'image_name': image_name,
        'mode': 'pipeline'
    })


@upload_bp.route('/upload/pdf-select', methods=['POST'])
def pdf_select_page():
    """Select a page from a multi-page PDF and convert it to PNG."""
    data = request.get_json()
    if not data:
        return jsonify({'error': 'No data provided'}), 400

    session_id = data.get('session_id')
    page_num = data.get('page', 0)

    if not session_id:
        return jsonify({'error': 'Missing session_id'}), 400

    session_dir = os.path.join(UPLOAD_DIR, session_id)
    if not os.path.isdir(session_dir):
        return jsonify({'error': 'Session not found'}), 404

    # Find the PDF file in session dir
    pdf_files = [f for f in os.listdir(session_dir) if f.lower().endswith('.pdf')]
    if not pdf_files:
        return jsonify({'error': 'No PDF file found in session'}), 404

    pdf_path = os.path.join(session_dir, pdf_files[0])
    stem = Path(pdf_files[0]).stem

    try:
        png_path = _convert_pdf_page_to_png(pdf_path, session_dir, stem, page_num)
        os.remove(pdf_path)
        image_name = os.path.basename(png_path)

        # Update session metadata
        meta_path = os.path.join(session_dir, 'session.json')
        with open(meta_path, 'r') as mf:
            meta = json.load(mf)
        meta['image_name'] = image_name
        with open(meta_path, 'w') as mf:
            json.dump(meta, mf, indent=2)

    except Exception as e:
        return jsonify({'error': f'Failed to convert PDF page: {str(e)}'}), 400

    return jsonify({
        'session_id': session_id,
        'image_name': image_name,
        'mode': 'pipeline',
    })


@upload_bp.route('/upload/results', methods=['POST'])
def upload_results():
    """Upload a ZIP of existing results to start an annotation session."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file uploaded'}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({'error': 'No file selected'}), 400

    if not f.filename.lower().endswith('.zip'):
        return jsonify({'error': 'Please upload a ZIP file'}), 400

    # Create temp location for ZIP
    session_id = str(uuid.uuid4())[:12]
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)

    zip_path = os.path.join(session_dir, 'upload.zip')
    f.save(zip_path)

    # Extract ZIP
    try:
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(session_dir)
    except zipfile.BadZipFile:
        shutil.rmtree(session_dir)
        return jsonify({'error': 'Invalid ZIP file'}), 400

    os.remove(zip_path)

    # If files are in a subdirectory, move them up
    subdirs = [d for d in os.listdir(session_dir)
               if os.path.isdir(os.path.join(session_dir, d)) and d != '__MACOSX']
    if len(subdirs) == 1 and not find_file(session_dir, '_sam2_results.json'):
        subdir = os.path.join(session_dir, subdirs[0])
        for item in os.listdir(subdir):
            src = os.path.join(subdir, item)
            dst = os.path.join(session_dir, item)
            shutil.move(src, dst)
        os.rmdir(subdir)

    # Remove __MACOSX if present
    macosx_dir = os.path.join(session_dir, '__MACOSX')
    if os.path.isdir(macosx_dir):
        shutil.rmtree(macosx_dir)

    # Find image and determine stem
    image_path = get_image_path(session_dir)
    if not image_path:
        # Try to infer stem from result files
        results_file = find_file(session_dir, '_sam2_results.json')
        if results_file:
            stem = os.path.basename(results_file).replace('_sam2_results.json', '')
            # Try to find original image from the results JSON
            data = json.load(open(results_file))
            orig_image = data.get('image_path', '')
            if orig_image and os.path.exists(orig_image):
                # Copy original image into session
                shutil.copy2(orig_image, session_dir)
                image_path = os.path.join(session_dir, os.path.basename(orig_image))
        else:
            stem = 'unknown'
    else:
        stem = Path(image_path).stem

    image_name = os.path.basename(image_path) if image_path else 'unknown'

    # Detect completed steps
    steps = _detect_completed_steps(session_dir)

    # Create session metadata
    meta = {
        'id': session_id,
        'created': datetime.now().isoformat(),
        'image_name': image_name,
        'image_stem': stem,
        'steps_complete': steps,
    }

    with open(os.path.join(session_dir, 'session.json'), 'w') as f_out:
        json.dump(meta, f_out, indent=2)

    return jsonify({
        'session_id': session_id,
        'image_name': image_name,
        'mode': 'annotation',
        'steps_complete': steps,
    })


@upload_bp.route('/session/<session_id>/status', methods=['GET'])
def session_status(session_id):
    """Get session status including which pipeline steps are complete."""
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    if not os.path.isdir(session_dir):
        return jsonify({'error': 'Session not found'}), 404

    meta_path = os.path.join(session_dir, 'session.json')
    if not os.path.exists(meta_path):
        return jsonify({'error': 'Session metadata not found'}), 404

    with open(meta_path, 'r') as f:
        meta = json.load(f)

    # Re-detect steps (files may have been created since session start)
    meta['steps_complete'] = _detect_completed_steps(session_dir)

    # Save updated meta
    with open(meta_path, 'w') as f:
        json.dump(meta, f, indent=2)

    has_image = get_image_path(session_dir) is not None

    return jsonify({
        'session_id': session_id,
        'image_name': meta.get('image_name', ''),
        'image_stem': meta.get('image_stem', ''),
        'has_image': has_image,
        'steps_complete': meta['steps_complete'],
        'created': meta.get('created', ''),
    })
