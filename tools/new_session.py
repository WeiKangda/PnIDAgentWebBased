#!/usr/bin/env python3
"""Create an annotation session from an image without the web upload.

  python tools/new_session.py <image> [--id SESSION_ID] [--results DIR_OR_ZIP]

Copies the image into uploads/<session id>/, writes session.json and the empty result files
(symbols, classification, text, lines, graph) so every editor tab works at once.  With --results,
existing result files (a folder or a ZIP, e.g. an earlier export) are copied in instead of empty ones.
Prints the session id and the workspace URL.
"""
import argparse
import json
import os
import shutil
import sys
import uuid
import zipfile
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import UPLOAD_DIR, URL_PREFIX  # noqa: E402
from api.session_utils import ensure_result_files  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('image')
    ap.add_argument('--id', help='session id (default: random)')
    ap.add_argument('--results', help='folder or ZIP of result files to start from')
    ap.add_argument('--port', type=int, default=5001)
    args = ap.parse_args()

    session_id = args.id or str(uuid.uuid4())[:12]
    session_dir = os.path.join(UPLOAD_DIR, session_id)
    os.makedirs(session_dir, exist_ok=True)
    image_name = os.path.basename(args.image)
    shutil.copy2(args.image, os.path.join(session_dir, image_name))

    if args.results:
        if os.path.isdir(args.results):
            for f in os.listdir(args.results):
                if f.endswith('.json') and f != 'session.json':
                    shutil.copy2(os.path.join(args.results, f), session_dir)
        else:
            with zipfile.ZipFile(args.results) as zf:
                for n in zf.namelist():
                    base = os.path.basename(n)
                    if base.endswith('.json') and base != 'session.json':
                        with zf.open(n) as src, open(os.path.join(session_dir, base), 'wb') as dst:
                            dst.write(src.read())

    meta = {
        'id': session_id,
        'created': datetime.now().isoformat(),
        'image_name': image_name,
        'image_stem': os.path.splitext(image_name)[0],
        'steps_complete': {k: True for k in ('symbol_detection', 'classification', 'text_detection',
                                             'line_detection', 'digitization')},
    }
    with open(os.path.join(session_dir, 'session.json'), 'w') as f:
        json.dump(meta, f, indent=2)
    created = ensure_result_files(session_dir)
    print(session_id)
    print(f'http://localhost:{args.port}{URL_PREFIX}/workspace/{session_id}')
    if created:
        print('created empty result files:', ', '.join(created), file=sys.stderr)


if __name__ == '__main__':
    main()
