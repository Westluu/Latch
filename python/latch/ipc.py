from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from collections.abc import Awaitable, Callable
from typing import Any


JsonMessage = dict[str, Any]
MessageHandler = Callable[[JsonMessage], Awaitable[None]]


def get_socket_dir() -> str:
    base = os.environ.get("XDG_RUNTIME_DIR", tempfile.gettempdir())
    socket_dir = os.path.join(base, "latch")
    os.makedirs(socket_dir, exist_ok=True)
    return socket_dir


def build_socket_path(cwd: str, channel: str, session_id: str = "") -> str:
    key = hashlib.sha256((cwd + session_id).encode()).hexdigest()[:12]
    return os.path.join(get_socket_dir(), f"{key}-{channel}.sock")


def cleanup_socket(socket_path: str) -> None:
    try:
        if os.path.exists(socket_path):
            os.unlink(socket_path)
    except OSError:
        pass


async def start_ipc_server(socket_path: str, on_message: MessageHandler):
    cleanup_socket(socket_path)

    async def handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        buffer = ""
        while True:
            data = await reader.read(4096)
            if not data:
                break
            buffer += data.decode()
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                    await on_message(msg)
                    writer.write(b"ok\n")
                except json.JSONDecodeError:
                    writer.write(b"error: invalid json\n")
                await writer.drain()
        writer.close()
        await writer.wait_closed()

    return await asyncio.start_unix_server(handle_client, path=socket_path)


async def send_json_message(socket_path: str, msg: JsonMessage) -> None:
    if not os.path.exists(socket_path):
        return
    try:
        reader, writer = await asyncio.open_unix_connection(socket_path)
        writer.write((json.dumps(msg) + "\n").encode())
        await writer.drain()
        await reader.read(64)
        writer.close()
        await writer.wait_closed()
    except (ConnectionError, OSError, asyncio.IncompleteReadError):
        pass
