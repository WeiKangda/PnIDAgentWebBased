#!/usr/bin/env python3
"""P&ID Web Annotation Tool - Flask Application"""
import os
import sys

# Add PnIDAgent to path for importing its modules
from config import PNIDAGENT_DIR, UPLOAD_DIR, MAX_CONTENT_LENGTH
if PNIDAGENT_DIR not in sys.path:
    sys.path.insert(0, PNIDAGENT_DIR)

from flask import Flask

def create_app():
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
    app.config['SECRET_KEY'] = 'pnid-web-tool-dev-key'

    os.makedirs(UPLOAD_DIR, exist_ok=True)

    # Register blueprints
    from api.upload import upload_bp
    from api.pipeline_api import pipeline_bp
    from api.masks import masks_bp
    from api.classification import classification_bp
    from api.text import text_bp
    from api.lines import lines_bp
    from api.image import image_bp
    from api.export import export_bp

    app.register_blueprint(upload_bp, url_prefix='/api')
    app.register_blueprint(pipeline_bp, url_prefix='/api')
    app.register_blueprint(masks_bp, url_prefix='/api')
    app.register_blueprint(classification_bp, url_prefix='/api')
    app.register_blueprint(text_bp, url_prefix='/api')
    app.register_blueprint(lines_bp, url_prefix='/api')
    app.register_blueprint(image_bp, url_prefix='/api')
    app.register_blueprint(export_bp, url_prefix='/api')

    # Page routes
    from flask import render_template, redirect, url_for

    @app.route('/')
    def index():
        return render_template('index.html')

    @app.route('/workspace/<session_id>')
    def workspace(session_id):
        session_dir = os.path.join(UPLOAD_DIR, session_id)
        if not os.path.isdir(session_dir):
            return redirect(url_for('index'))
        return render_template('workspace.html', session_id=session_id)

    return app


if __name__ == '__main__':
    app = create_app()
    app.run(debug=True, host='0.0.0.0', port=5001)
