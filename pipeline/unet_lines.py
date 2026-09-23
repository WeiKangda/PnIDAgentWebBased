"""Single-image wrapper around PnIDAgent's U-Net pipe-centreline extractor.

`eval_tools/line_seg.py` in the PnIDAgent submodule is dataset-bound: its
`predict` mode walks `dataset/image_2/<id>.jpg` and writes one JSON keyed by
sheet id.  The web tool needs the opposite shape -- one uploaded drawing in, one
`*_step4_lines.json` out, in the same schema the classical stage writes so the
line editor and the digitizer do not care which extractor produced it.

The U-Net was trained at the synthetic sheets' native 7168px width, so the image
is resized to `target_width` first (exactly as `process_text_lines.py` does) and
the segments come back in that resized space with the same `scale` field.  That
keeps line, text and symbol coordinates in one space downstream.

Requires torch, which lives in a different environment than PaddleOCR (paddleocr
pins opencv 4.6 and paddlepaddle-gpu downgrades the nccl/cudnn torch needs).
Import failures are reported as a clear error rather than crashing the request.
"""
import os
import sys

import cv2
import numpy as np

from config import PNIDAGENT_DIR

EVAL_TOOLS = os.path.join(PNIDAGENT_DIR, 'eval_tools')


class UNetUnavailable(RuntimeError):
    """torch, the checkpoint, or the submodule's eval_tools are missing."""


def _import_line_seg():
    for p in (PNIDAGENT_DIR, EVAL_TOOLS):
        if p not in sys.path:
            sys.path.insert(0, p)
    try:
        import line_seg
    except ImportError as e:
        raise UNetUnavailable(
            f"cannot import eval_tools/line_seg.py from {EVAL_TOOLS}: {e}. "
            "Run `git submodule update --init` and check the submodule is on a "
            "commit that has eval_tools/."
        ) from e
    return line_seg


def available(ckpt_path):
    """Whether a U-Net run would work, without loading the model."""
    if not ckpt_path or not os.path.exists(ckpt_path):
        return False, f"checkpoint not found: {ckpt_path}"
    try:
        import torch  # noqa: F401
    except ImportError:
        return False, "torch is not installed in this environment"
    if not os.path.exists(os.path.join(EVAL_TOOLS, 'line_seg.py')):
        return False, f"{EVAL_TOOLS}/line_seg.py missing (submodule not updated?)"
    return True, None


def detect_lines(image_path, ckpt_path, device='cuda', tile=1024, min_len=100,
                 target_width=7168, progress=None):
    """Run the U-Net extractor on one drawing.

    Returns a dict in the `_step4_lines.json` schema:
    {"solid": [[x1,y1,x2,y2], ...], "dashed": [...], "notes_xmin": None,
     "image_path": str, "target_width": int, "scale": float,
     "resized_shape": [h, w], "line_source": "unet"}
    """
    ok, why = available(ckpt_path)
    if not ok:
        raise UNetUnavailable(why)

    import torch
    line_seg = _import_line_seg()

    def say(msg):
        if progress:
            progress(msg)

    say('Loading image...')
    img = cv2.imread(image_path)
    if img is None:
        raise RuntimeError(f'failed to read {image_path}')
    h0, w0 = img.shape[:2]

    # Same resize the classical stage applies, so both extractors emit
    # coordinates in one space and `scale` means the same thing.
    scale = 1.0
    if w0 != target_width:
        scale = target_width / float(w0)
        img = cv2.resize(img, (target_width, int(round(h0 * scale))),
                         interpolation=cv2.INTER_LINEAR)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    say('Loading U-Net checkpoint...')
    dev = torch.device(device if torch.cuda.is_available() or device == 'cpu'
                       else 'cpu')
    ck = torch.load(ckpt_path, map_location='cpu')
    model = line_seg.build_model(ck.get('base', 32)).to(dev)
    if dev.type == 'cuda':
        model = model.to(memory_format=torch.channels_last)
    model.load_state_dict(ck['model'])
    model.eval()

    say(f'Segmenting pipes ({gray.shape[1]}x{gray.shape[0]}, tile {tile})...')
    if dev.type == 'cuda':
        mask = line_seg.predict_mask(model, gray, dev, tile=tile)
    else:
        # predict_mask hardcodes an autocast("cuda") context; on CPU run it with
        # autocast disabled rather than duplicating the tiling logic.
        with torch.autocast('cuda', enabled=False):
            mask = line_seg.predict_mask(model, gray, dev, tile=tile)

    say('Extracting segments...')
    solid = line_seg.mask_to_segments(mask, 1, min_len=min_len)
    dashed = line_seg.mask_to_segments(mask, 2, min_len=min_len)

    return {
        'solid': [list(map(int, s)) for s in solid],
        'dashed': [list(map(int, s)) for s in dashed],
        'notes_xmin': None,          # the U-Net learned the crop; nothing to mask
        'image_path': str(image_path),
        'target_width': int(target_width),
        'scale': float(scale),
        'resized_shape': [int(gray.shape[0]), int(gray.shape[1])],
        'line_source': 'unet',
    }
