"""
Pipeline Runner - wraps PnIDAgent pipeline for web use.
This module is imported by api/pipeline_api.py.
"""
import os
import sys
from config import PNIDAGENT_DIR

# Ensure PnIDAgent modules are importable
if PNIDAGENT_DIR not in sys.path:
    sys.path.insert(0, PNIDAGENT_DIR)
