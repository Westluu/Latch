from __future__ import annotations

import atexit
import os
import signal
import sys
from collections.abc import Sequence
from typing import Callable


def ui_dir() -> str:
    return os.path.dirname(os.path.abspath(__file__))


def python_root() -> str:
    return os.path.dirname(ui_dir())


def repo_root() -> str:
    return os.path.dirname(python_root())


def bootstrap_python_root() -> str:
    root = python_root()
    if root not in sys.path:
        sys.path.insert(0, root)
    return root


def dist_cli_path() -> str:
    return os.path.join(repo_root(), "dist", "cli.js")


def arg_value(argv: Sequence[str], index: int, default: str = "") -> str:
    return argv[index] if len(argv) > index else default


def require_directory_arg(argv: Sequence[str], index: int, usage: str) -> str:
    if len(argv) <= index:
        print(usage, file=sys.stderr)
        sys.exit(1)

    cwd = os.path.abspath(argv[index])
    if not os.path.isdir(cwd):
        print(f"Error: {cwd!r} is not a directory", file=sys.stderr)
        sys.exit(1)
    return cwd


def register_socket_cleanup(socket_path: str, cleanup: Callable[[str], None]) -> None:
    atexit.register(cleanup, socket_path)
    signal.signal(signal.SIGHUP, lambda *_: (cleanup(socket_path), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (cleanup(socket_path), sys.exit(0)))
