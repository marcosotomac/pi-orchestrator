#!/usr/bin/env python3
"""Explicit opt-in official ACP install. No auth, model requests or global configuration.
Release hash: official agentclientprotocol/registry antigravity-acp/agent.json, 1.4.5.
Only macOS arm64 is qualified here; other platforms fail closed.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import tempfile
import urllib.request
import zipfile

VERSION = '1.4.5'
SHA256 = '886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f'
SIZE = 97923855
URL = 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip'
MEMBERS = {'agy_acp_server.par': 178915920, 'localharness_external': 122957936}
ROOT = Path(__file__).resolve().parent.parent / '.runtimes' / 'antigravity'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe private runtime directory')


def extract(archive, destination, members):
    # Never extractall: reject traversal, duplicate names, links and unexpected files.
    with zipfile.ZipFile(archive) as zipped:
        entries = zipped.infolist()
        if len(entries) != len(members) or set(item.filename for item in entries) != set(members):
            raise ValueError('Unexpected archive members')
        for item in entries:
            if item.file_size != members[item.filename] or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('Invalid member type or size')
            target = destination / item.filename
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
            with os.fdopen(os.open(target, flags, 0o700), 'wb') as out, zipped.open(item) as source:
                count = 0
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    count += len(chunk)
                    if count > members[item.filename]:
                        raise ValueError('Expanded member exceeds limit')
                    out.write(chunk)
                if count != members[item.filename]:
                    raise ValueError('Truncated member')
                out.flush()
                os.fsync(out.fileno())


def install():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('Only macOS arm64 is qualified by this installer')
    os.umask(0o077)
    # Project-local private ancestors only; never a user/global runtime installation.
    for directory in [ROOT.parent, ROOT]:
        directory.mkdir(mode=0o700, exist_ok=True)
        private_directory(directory)
    # A fresh ACP-owned account profile, never IDE/CLI tokens. Existing settings are not replaced.
    profile = ROOT / 'profile'
    for directory in [profile, profile / 'antigravity-acp']:
        directory.mkdir(mode=0o700, exist_ok=True)
        private_directory(directory)
    settings = profile / 'antigravity-acp/settings.json'
    if not settings.exists() and not settings.is_symlink():
        with os.fdopen(os.open(settings, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'w') as out:
            json.dump({'auth': {'type': 'oauth-personal'}}, out)
    if settings.is_symlink() or settings.stat().st_mode & 0o077 or settings.stat().st_uid != os.getuid():
        raise ValueError('Unsafe profile settings')
    target = ROOT / VERSION
    if target.exists() or target.is_symlink():
        private_directory(target)
        record = json.loads((target / 'release.json').read_text())
        if record.get('archiveSha256') != SHA256 or record.get('version') != VERSION:
            raise ValueError('Existing release mismatch; never overwrite')
        for name, size in MEMBERS.items():
            path = target / name
            if path.is_symlink() or path.stat().st_size != size or digest(path) != record['files'][name]:
                raise ValueError('Existing executable integrity mismatch')
        print('PASS: existing private official release verified')
        return
    if shutil.disk_usage(ROOT).free < SIZE + sum(MEMBERS.values()) + 256 * 1024 * 1024:
        raise ValueError('Insufficient free space')
    with tempfile.TemporaryDirectory(prefix='.install-', dir=ROOT) as stage_name:
        stage = Path(stage_name)
        archive = stage / 'download.zip'
        request = urllib.request.Request(URL, headers={'User-Agent': 'pi-orchestrator-experimental-installer'})
        with urllib.request.urlopen(request, timeout=120) as response, archive.open('xb') as out:
            if response.url != URL:
                raise ValueError('Unexpected download redirect')
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > SIZE:
                    raise ValueError('Download exceeds pinned size')
                out.write(chunk)
        if total != SIZE or digest(archive) != SHA256:
            raise ValueError('Official archive size/SHA-256 mismatch')
        release = stage / 'release'
        release.mkdir(mode=0o700)
        extract(archive, release, MEMBERS)
        record = {'version': VERSION, 'source': URL, 'archiveSha256': SHA256, 'archiveBytes': SIZE,
                  'license': 'proprietary; https://antigravity.google/terms',
                  'files': {name: digest(release / name) for name in MEMBERS}}
        (release / 'release.json').write_text(json.dumps(record, indent=2))
        # No replacement of another release. A concurrent installer losing the race fails.
        os.rename(release, target)
    print('PASS: official archive verified and installed privately; no authentication performed')
    print('Runtime: ' + str(target / 'agy_acp_server.par'))


if __name__ == '__main__':
    try:
        install()
    except Exception:
        print('FAIL: private ACP installation failed; no global configuration changed')
        raise SystemExit(1)
