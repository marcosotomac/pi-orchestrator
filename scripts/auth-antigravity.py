#!/usr/bin/env python3
"""Explicit official ACP OAuth flow. No session creation, prompt or model request.
Account credentials are written only by the official runtime into its project-private profile.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import time
import importlib.util
import sys
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtimes/antigravity/1.4.5'
PROFILE = RUNTIME.parent / 'profile'


def authenticate():
    os.umask(0o077)
    # Reuse the installer solely to verify files/profile first; never download from this flow.
    spec = importlib.util.spec_from_file_location('installer', ROOT / 'scripts/install-antigravity.py')
    installer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(installer)
    installer.private_directory(RUNTIME)
    record = json.loads((RUNTIME / 'release.json').read_text())
    if record.get('archiveSha256') != installer.SHA256 or record.get('version') != installer.VERSION:
        raise ValueError('Release mismatch')
    for name, size in installer.MEMBERS.items():
        path = RUNTIME / name
        if path.is_symlink() or path.stat().st_size != size or installer.digest(path) != record['files'][name]:
            raise ValueError('Runtime integrity mismatch')
    for path in [PROFILE, PROFILE / 'antigravity-acp']:
        installer.private_directory(path)
    settings = PROFILE / 'antigravity-acp/settings.json'
    if settings.is_symlink() or settings.stat().st_mode & 0o077 or json.loads(settings.read_text()).get('auth', {}).get('type') != 'oauth-personal':
        raise ValueError('Profile mismatch')
    hook = ROOT / 'scripts/antigravity-browser.py'
    hook.chmod(0o700)
    env = {k: v for k, v in os.environ.items() if not (k.startswith(('GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'AGY_ACP_', 'GEMINI_')) or k in ['BROWSER', 'ANTIGRAVITY_HARNESS_PATH'])}
    env.update(GEMINI_HOME=str(PROFILE), AGY_ACP_FORCE_FILE_STORAGE='1', ANTIGRAVITY_HARNESS_PATH=str(RUNTIME / 'localharness_external'), BROWSER=str(hook), PYTHONUNBUFFERED='1')
    errors_path = ROOT / 'artifacts/antigravity-auth-private.stderr'
    errors_path.parent.mkdir(exist_ok=True)
    started = time.time()
    completed = False
    with errors_path.open('wb') as errors:
        os.chmod(errors_path, 0o600)
        process = subprocess.Popen([str(RUNTIME / 'agy_acp_server.par')], cwd=PROFILE, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, start_new_session=True)
        try:
            def send(identifier, method, params):
                process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': identifier, 'method': method, 'params': params})+'\n').encode())
                process.stdin.flush()
            send(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}, 'clientInfo': {'name': 'pi-orchestrator', 'version': '0.1.0'}})
            selector = selectors.DefaultSelector()
            selector.register(process.stdout, selectors.EVENT_READ)
            deadline = time.monotonic() + 600
            buffer = b''
            while time.monotonic() < deadline:
                if not selector.select(timeout=0.2):
                    continue
                chunk = os.read(process.stdout.fileno(), 65536)
                if not chunk:
                    raise ValueError('Runtime closed before authentication acknowledgement')
                buffer += chunk
                if len(buffer) > 1048576:
                    raise ValueError('ACP protocol exceeds limit')
                while b'\n' in buffer:
                    line, buffer = buffer.split(b'\n', 1)
                    if line.startswith(b'Open the following link to authenticate the ACP server: '):
                        # The native BROWSER hook handles opening; do not echo OAuth URL/state.
                        continue
                    message = json.loads(line)
                    if 'error' in message:
                        raise ValueError('ACP request rejected')
                    if message.get('id') == 1:
                        result = message.get('result', {})
                        if result.get('agentInfo', {}).get('name') != 'antigravity-acp' or result.get('agentInfo', {}).get('version') != '1.4.5' or not any(item.get('id') == 'oauth-personal' for item in result.get('authMethods', [])):
                            raise ValueError('Runtime identity/auth capability mismatch')
                        send(2, 'authenticate', {'methodId': 'oauth-personal'})
                        print('Waiting for official Google sign-in in your browser (up to 10 minutes). No model request.', flush=True)
                    if message.get('id') == 2 and 'result' in message:
                        completed = True
                        break
                if completed:
                    break
            if not completed:
                raise ValueError('Authentication deadline expired')
        finally:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)
    report = {'startedAt': started, 'endedAt': time.time(), 'authenticated': completed, 'method': 'oauth-personal', 'scope': 'Official ACP authenticate acknowledgement only; no session, model call, credential copying or global configuration changes'}
    path = ROOT / 'artifacts/antigravity-auth.json'
    path.write_text(json.dumps(report, indent=2)); os.chmod(path, 0o600)
    print('PASS: official ACP OAuth authentication acknowledged; no tasks launched.')
    print('Evidence: ' + str(path))


if __name__ == '__main__':
    try:
        authenticate()
    except (Exception, KeyboardInterrupt):
        print('FAIL: ACP authentication not confirmed; private diagnostics retained, no credentials or OAuth URLs printed.')
        raise SystemExit(1)
