#!/usr/bin/env python3
"""Make the manual-mode packages (flask, numpy, cv2) importable on a machine without internet, pip or root.

  python3 tools/offline_deps.py [--vendor DIR] [--target DIR] [--force] [--check]

If flask (3 or newer), numpy and cv2 already import, nothing is printed and the exit code is 0.
Otherwise the wheels in vendor/ that fit this interpreter (Python tag, ABI, machine, glibc) are unpacked
into <target>/<python tag>-<machine>/ (default target: pylib/ next to app.py), the imports are checked
from there, and that folder is printed on stdout so a launcher can put it on PYTHONPATH:

  LIB="$(python3 tools/offline_deps.py)" && export PYTHONPATH="$LIB${PYTHONPATH:+:$PYTHONPATH}"

A wheel is a ZIP of the files pip copies into site-packages, so unpacking it is the installation; nothing
else is needed. Messages go to stderr; the exit code is 1 when a package has no usable wheel.

Fill vendor/ with one pip download per Python version the target machine may have, e.g.
  pip download -r requirements-manual.txt -d vendor --only-binary=:all: --platform manylinux2014_x86_64 --python-version 3.10
"""
import argparse
import os
import platform
import re
import shutil
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
REQUIRED = ('flask', 'numpy', 'opencv_python_headless')          # distributions (wheel names) that must be there
CHECK = ("import importlib.metadata as m, flask, numpy, cv2\n"
         "v = m.version('flask')\n"
         "assert int(v.split('.')[0]) >= 3, 'flask %s is older than 3' % v\n")
LEGACY_GLIBC = {'manylinux1': (2, 5), 'manylinux2010': (2, 12), 'manylinux2014': (2, 17)}


def check_imports(env=None):
    """None when flask>=3, numpy and cv2 import in a fresh interpreter (with env), else the error."""
    p = subprocess.run([sys.executable, '-c', CHECK], env=env, capture_output=True, text=True)
    if p.returncode == 0:
        return None
    lines = p.stderr.strip().splitlines()
    return lines[-1] if lines else 'import failed'


def glibc_version():
    name, ver = platform.libc_ver()
    if name != 'glibc':
        return None
    try:
        return tuple(int(x) for x in ver.split('.')[:2])
    except ValueError:
        return None


def platform_ok(tag, machine, libc):
    if tag == 'any':
        return True
    if not sys.platform.startswith('linux'):
        return False
    m = re.match(r'^(manylinux1|manylinux2010|manylinux2014|manylinux_(\d+)_(\d+)|linux)_(.+)$', tag)
    if not m or m.group(4) != machine:
        return False
    if m.group(1) == 'linux':
        return True
    need = (int(m.group(2)), int(m.group(3))) if m.group(2) else LEGACY_GLIBC[m.group(1)]
    return libc is None or libc >= need


def wheel_ok(fname, machine, libc):
    """Does this wheel fit the running interpreter and machine?"""
    if not fname.endswith('.whl'):
        return False
    parts = fname[:-4].split('-')
    if len(parts) not in (5, 6):
        return False
    py, abi, plat = parts[-3], parts[-2], parts[-1]
    major, minor = sys.version_info[:2]
    cpython = platform.python_implementation() == 'CPython'
    tags = py.split('.')
    if abi == 'none':
        ok = any(t in (f'py{major}', f'py{major}{minor}', f'cp{major}{minor}') for t in tags)
    elif abi == 'abi3':
        ok = cpython and any(re.fullmatch(rf'cp{major}(\d+)', t) and int(t[len(f'cp{major}'):]) <= minor for t in tags)
    elif abi == f'cp{major}{minor}':
        ok = cpython and f'cp{major}{minor}' in tags
    else:
        ok = False
    return ok and any(platform_ok(p, machine, libc) for p in plat.split('.'))


def version_key(ver):
    return [(0, int(p)) if p.isdigit() else (1, p) for p in re.split(r'[.\-+]', ver)]


def select_wheels(vendor, machine, libc):
    """{distribution: wheel file name}: the newest fitting wheel of every distribution in vendor/."""
    best = {}
    for f in sorted(os.listdir(vendor)):
        if wheel_ok(f, machine, libc):
            name, ver = f[:-4].split('-')[:2]
            name = name.lower().replace('-', '_')
            if name not in best or version_key(ver) > version_key(best[name][1]):
                best[name] = (f, ver)
    return {n: fv[0] for n, fv in best.items()}


def unpack(vendor, wheels, target):
    os.makedirs(target, exist_ok=True)
    for f in wheels:
        with zipfile.ZipFile(os.path.join(vendor, f)) as zf:
            zf.extractall(target)
    # <dist>-<ver>.data/{purelib,platlib} belong at the top level; scripts, headers and data are not needed
    for d in os.listdir(target):
        p = os.path.join(target, d)
        if d.endswith('.data') and os.path.isdir(p):
            for sub in ('purelib', 'platlib'):
                if os.path.isdir(os.path.join(p, sub)):
                    shutil.copytree(os.path.join(p, sub), target, dirs_exist_ok=True)
            shutil.rmtree(p)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--vendor', default=os.path.join(ROOT, 'vendor'), help='folder of wheels (default: vendor/)')
    ap.add_argument('--target', default=os.path.join(ROOT, 'pylib'), help='where to unpack (default: pylib/)')
    ap.add_argument('--force', action='store_true', help='unpack again even if the folder is up to date')
    ap.add_argument('--check', action='store_true', help='only report whether the packages import (exit 0 / 1)')
    args = ap.parse_args()

    err = check_imports()
    if err is None:
        return 0
    if args.check:
        print(err, file=sys.stderr)
        return 1
    machine, libc = platform.machine(), glibc_version()
    this = f"Python {sys.version.split()[0]} ({platform.python_implementation()}) on {sys.platform} {machine}"
    if libc:
        this += ' glibc %d.%d' % libc
    if not os.path.isdir(args.vendor) or not any(f.endswith('.whl') for f in os.listdir(args.vendor)):
        print(f'{err}; no wheels in {args.vendor} to install from ({this})', file=sys.stderr)
        return 1
    wheels = select_wheels(args.vendor, machine, libc)
    missing = [d for d in REQUIRED if d not in wheels]
    if missing:
        have = ', '.join(f for f in sorted(os.listdir(args.vendor)) if f.endswith('.whl'))
        print(f'{err}; {args.vendor} has no wheel of {", ".join(missing)} for {this}.\nwheels there: {have}', file=sys.stderr)
        return 1
    impl = 'cp' if platform.python_implementation() == 'CPython' else sys.implementation.name
    target = os.path.join(args.target, f'{impl}{sys.version_info[0]}{sys.version_info[1]}-{machine}')
    marker = os.path.join(target, 'WHEELS.txt')
    wanted = ''.join(f + '\n' for f in sorted(wheels.values()))
    if args.force or not os.path.isfile(marker) or open(marker).read() != wanted:
        if os.path.isdir(target):
            shutil.rmtree(target)
        print(f'unpacking {len(wheels)} wheels from {args.vendor} into {target}', file=sys.stderr)
        unpack(args.vendor, wheels.values(), target)
        with open(marker, 'w') as f:
            f.write(wanted)
    env = dict(os.environ)
    env['PYTHONPATH'] = target + (os.pathsep + env['PYTHONPATH'] if env.get('PYTHONPATH') else '')
    err = check_imports(env)
    if err:
        print(f'the packages unpacked in {target} do not import: {err}', file=sys.stderr)
        return 1
    print(target)
    return 0


if __name__ == '__main__':
    sys.exit(main())
