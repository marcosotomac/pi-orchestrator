#!/usr/bin/env python3
"""Opt-in initialize-only probe: no authenticate, session/new or prompt request."""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
RUNTIME = ROOT / '.runtimes/antigravity/1.4.5'


def probe():
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='probe-', dir=RUNTIME.parent) as folder:
        profile = Path(folder)
        (profile / 'antigravity-acp').mkdir(mode=0o700)
        (profile / 'antigravity-acp/settings.json').write_text(json.dumps({'auth': {'type': 'oauth-personal'}}))
        env = {k: v for k, v in os.environ.items() if not (k.startswith(('GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'AGY_ACP_', 'GEMINI_')) or k in ['BROWSER', 'ANTIGRAVITY_HARNESS_PATH'])}
        env.update(GEMINI_HOME=str(profile), AGY_ACP_FORCE_FILE_STORAGE='1', ANTIGRAVITY_HARNESS_PATH=str(RUNTIME / 'localharness_external'), BROWSER='/usr/bin/false', PYTHONUNBUFFERED='1', TMPDIR=str(profile))
        stderr = profile / 'private-stderr.log'
        with stderr.open('wb') as errors:
            process = subprocess.Popen([str(RUNTIME / 'agy_acp_server.par')], cwd=profile, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, start_new_session=True)
            try:
                process.stdin.write((json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': 1, 'clientCapabilities': {'fs': {'readTextFile': False, 'writeTextFile': False}, 'terminal': False}, 'clientInfo': {'name': 'pi-orchestrator', 'version': '0.1.0'}}})+'\n').encode())
                process.stdin.flush()
                selector = selectors.DefaultSelector()
                selector.register(process.stdout, selectors.EVENT_READ)
                buffer = b''
                deadline = time.monotonic() + 90
                result = None
                while time.monotonic() < deadline:
                    if not selector.select(timeout=0.2):
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        raise ValueError('Runtime closed')
                    buffer += chunk
                    if len(buffer) > 1048576:
                        raise ValueError('Protocol exceeds limit')
                    while b'\n' in buffer:
                        line, buffer = buffer.split(b'\n', 1)
                        message = json.loads(line)
                        if message.get('id') == 1:
                            result = message.get('result')
                            break
                    if result is not None:
                        break
                if not result or result.get('agentInfo', {}).get('name') != 'antigravity-acp' or result.get('agentInfo', {}).get('version') != '1.4.5':
                    raise ValueError('Initialize validation failed')
                report = {'verifiedAt': time.time(), 'requestScope': 'initialize only; no authenticate, sessions, prompts or model quota', 'agentInfo': result.get('agentInfo'), 'protocolVersion': result.get('protocolVersion'), 'agentCapabilities': result.get('agentCapabilities'), 'authMethodIds': [item.get('id') for item in result.get('authMethods', [])]}
            finally:
                # The process group is owned by this live Popen, never reconstructed from disk.
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
        output = ROOT / 'artifacts/antigravity-initialize.json'
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(report, indent=2))
        os.chmod(output, 0o600)
        print('PASS: official Antigravity 1.4.5 initialized; no sign-in or model request')
        print('Evidence: ' + str(output))


if __name__ == '__main__':
    try:
        probe()
    except Exception:
        print('FAIL: ACP initialize probe; no credentials or provider errors printed')
        raise SystemExit(1)
