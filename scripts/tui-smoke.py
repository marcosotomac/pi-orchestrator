#!/usr/bin/env python3
"""Local PTY interaction with the actual Pi CLI. Fixture engines are Node, never AI CLIs."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import tempfile
import termios
import time

os.umask(0o077)  # Traces stay private; child fixture processes inherit the same mask.
ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / "artifacts"
ARTIFACTS.mkdir(exist_ok=True)
ANSI = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])")


def wait_for_exit(pid, drain, timeout=10):
    """PTY EOF can precede process exit; count elapsed time, never read iterations."""
    deadline = time.monotonic() + timeout
    while True:
        result, status = os.waitpid(pid, os.WNOHANG)
        if result:
            return status
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise AssertionError("Pi did not shut down normally before the deadline")
        drain(min(0.05, remaining))
        # drain() returns immediately on EOF. Yield so shutdown can finish without spinning.
        time.sleep(min(0.01, max(0, deadline - time.monotonic())))


def run(mode):
    with tempfile.TemporaryDirectory(prefix="pi-orchestrator-tui-") as workspace:
        lifeline_path = Path(workspace) / ".fixture-lifeline"
        os.mkfifo(lifeline_path, 0o600)
        lifeline = os.open(lifeline_path, os.O_RDWR | os.O_NONBLOCK)
        os.set_inheritable(lifeline, False)  # Pi/workers must not retain the writer on exec.
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(workspace)
            env = dict(os.environ, TERM="xterm-256color", PI_OFFLINE="1", NO_COLOR="", PI_ORCHESTRATOR_STATE_DIR=str(Path(workspace) / "state"))
            os.execvpe("pi", ["pi", "--offline", "--no-extensions", "--extension", str(ROOT / "test/fixtures/tui-extension.ts"),
                "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--no-session", "--no-mcp", "--tui-mode", mode], env)
        raw = bytearray()
        steps = []
        status = None

        def resize(rows, cols):
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.kill(pid, signal.SIGWINCH)

        def drain(seconds=0.2):
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                if select.select([master], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(master, 65536)
                        if not chunk:
                            return
                        raw.extend(chunk)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            return
                        raise

        def send(data):
            mark = len(raw)
            os.write(master, data.encode() if isinstance(data, str) else data)
            return mark

        def expect(text, mark=0, timeout=15):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                drain(0.1)
                if text in ANSI.sub("", raw[mark:].decode("utf8", errors="replace")):
                    steps.append(text)
                    return
            raise AssertionError(f"{mode}: expected {text!r}; tail: {ANSI.sub('', raw[-2500:].decode('utf8', errors='replace'))}")

        try:
            resize(32, 110)
            drain(2)
            mark = send("/orch\r")
            expect("Orquestador · sin tareas", mark)
            expect("Sin tareas", mark)
            send(b"\x1b")
            drain(0.3)
            mark = send("/orch start codex Tarea SIMULADA de prueba\r")
            expect("2 en curso", mark)
            mark = send("/orch\r")
            expect("d detalles", mark)
            mark = send("d")
            expect("Intento:", mark)
            mark = send("d")
            expect("d detalles", mark)
            mark = send("f")
            expect("mostrando activas", mark)
            mark = send("f")
            expect("No hay tareas con este filtro", mark)
            mark = send("f")
            expect("Esc cerrar", mark)
            mark = send("c")
            expect("esta tarea y su subtarea?", mark)
            send("n")  # Reject the pending stop, then close without cancelling.
            drain(0.1)
            send(b"\x1b")
            drain(0.3)
            mark = send("/orch\r")
            expect("2 en curso", mark)
            send(b"\x1b[B")  # Child, not its parent.
            mark = send("c")
            expect("Cancelar esta tarea?", mark)
            send("n")
            drain(0.1)
            send(b"\x1b[A")
            mark = send("c")
            expect("esta tarea y su subtarea?", mark)
            mark = send("y")
            expect("cancelando", mark)
            expect("Cancelación finalizada", mark)
            expect("2 canceladas", mark)
            mark = len(raw)
            resize(14, 32)
            drain(0.4)
            assert len(raw) > mark, "resize must cause a render"
            resize(32, 110)
            drain(0.2)
            send(b"\x1b")
            drain(0.3)
            mark = send("/orch reset\r")
            expect("Orquestador reiniciado", mark)
            archives = list((Path(workspace) / "state").glob("*.json"))
            assert len(archives) == 1, "reset closes one durable coordinator run"
            before = archives[0].read_bytes()
            archived = json.loads(before)
            assert archived.get("closedAt"), "normal reset must durably record closure"
            assert len(archived["tasks"]) == 2 and all(task["state"] == "cancelled" and task["runtimeProcess"].get("exitedAt") for task in archived["tasks"])
            mark = send("/orch history\r")
            expect("Historial persistido", mark)
            expect("cierre registrado", mark)
            mark = send(f"/orch inspect {archived['runId'][:8]}\r")
            expect(f"Archivo {archived['runId']}", mark)
            expect("Estado guardado", mark)
            mark = send(f"/orch reconcile {archived['runId'][:8]}\r")
            expect("closure-recorded", mark)
            expect("exit-recorded", mark)
            assert archives[0].read_bytes() == before, "history/inspect/reconcile must not mutate archived state"
            assert len(list((Path(workspace) / "state").glob("*.json"))) == 1, "history commands do not start a service/run"
            send(b"\x04")
            status = wait_for_exit(pid, drain)
            assert os.waitstatus_to_exitcode(status) == 0, status
            print(f"PASS PTY {mode}: tree, selection, reject/confirm cancel, cleanup, resize, editor focus, durable archive, read-only reconciliation and normal exit.")
        finally:
            if status is None:
                try:
                    send(b"\x1b")
                    drain(0.1)
                    send(b"\x04")
                    drain(1)
                    result, _ = os.waitpid(pid, os.WNOHANG)
                    if not result:
                        os.killpg(pid, signal.SIGKILL)
                        os.waitpid(pid, 0)
                except (OSError, ChildProcessError):
                    pass
            # Closing the private writer makes fixture workers exit themselves. No saved PIDs.
            os.close(lifeline)
            os.close(master)
            path = ARTIFACTS / f"tui-{mode}-{int(time.time() * 1000)}"
            path.with_suffix(".ansi").write_bytes(raw)
            path.with_suffix(".json").write_text(json.dumps({"mode": mode, "steps": steps, "exitStatus": status, "engines": "simulated Node processes; no model requests", "durability": "normal reset closes the run; archive inspection is read-only; this PTY test does not simulate a crash"}, indent=2))


if __name__ == "__main__":
    for mode in ["fullscreen", "regular"]:
        run(mode)
