#!/usr/bin/env python3
"""Stdlib-only RACP v1 agent interoperability example using golden vectors."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import uuid
from dataclasses import dataclass
from pathlib import Path


MAGIC = b"RACP"
VERSION = 1
STATUS_INTENT = 0x06
VALID_INTENTS = {1, 2, 3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22}
AGENT_NAME = re.compile(r"^@[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$")
DEFAULT_VECTORS = (
    Path(__file__).resolve().parents[1]
    / "tests"
    / "vectors"
    / "racp-v1-golden-vectors.json"
)


@dataclass(frozen=True)
class Envelope:
    intent: int
    from_agent: str
    to_agent: str
    task_id: str | None
    timestamp_ms: int
    payload: bytes


def unpack(frame: bytes) -> Envelope:
    """Strictly decode and authenticate one inline RACP v1 frame."""
    if len(frame) < 48 or frame[:4] != MAGIC or frame[4] != VERSION:
        raise ValueError("invalid RACP v1 frame")
    intent = frame[5]
    if intent not in VALID_INTENTS:
        raise ValueError("invalid RACP intent")
    cursor = 6
    from_agent, cursor = _read_agent(frame, cursor)
    to_agent, cursor = _read_agent(frame, cursor)
    if cursor + 34 > len(frame):
        raise ValueError("truncated RACP frame")
    task_bytes = frame[cursor : cursor + 16]
    cursor += 16
    timestamp_ms = struct.unpack_from(">Q", frame, cursor)[0]
    cursor += 8
    wire_hash = frame[cursor : cursor + 8]
    cursor += 8
    payload_length = struct.unpack_from(">H", frame, cursor)[0]
    cursor += 2
    payload = frame[cursor : cursor + payload_length]
    if cursor + payload_length != len(frame):
        raise ValueError("trailing or missing RACP payload bytes")
    if hashlib.sha256(payload).digest()[:8] != wire_hash:
        raise ValueError("RACP payload digest mismatch")
    task_id = None if task_bytes == bytes(16) else str(uuid.UUID(bytes=task_bytes))
    return Envelope(intent, from_agent, to_agent, task_id, timestamp_ms, payload)


def pack(envelope: Envelope) -> bytes:
    """Pack one inline RACP v1 frame with the exact language-neutral layout."""
    if envelope.intent not in VALID_INTENTS:
        raise ValueError("invalid RACP intent")
    from_bytes = _agent_bytes(envelope.from_agent)
    to_bytes = _agent_bytes(envelope.to_agent)
    if not 0 <= envelope.timestamp_ms <= 8_640_000_000_000_000:
        raise ValueError("invalid RACP timestamp")
    if len(envelope.payload) > 65_535:
        raise ValueError("RACP inline payload is too large")
    task_bytes = bytes(16) if envelope.task_id is None else uuid.UUID(
        envelope.task_id,
    ).bytes
    digest = hashlib.sha256(envelope.payload).digest()
    return b"".join(
        (
            MAGIC,
            bytes((VERSION, envelope.intent)),
            struct.pack(">H", len(from_bytes)),
            from_bytes,
            struct.pack(">H", len(to_bytes)),
            to_bytes,
            task_bytes,
            struct.pack(">Q", envelope.timestamp_ms),
            digest[:8],
            struct.pack(">H", len(envelope.payload)),
            envelope.payload,
        )
    )


class GoldenVectorAgent:
    """Tiny agent boundary: verify a request, then return a verified status frame."""

    def __init__(self, name: str):
        _agent_bytes(name)
        self.name = name

    def handle(self, frame: bytes) -> bytes:
        request = unpack(frame)
        if request.to_agent != self.name:
            raise ValueError("frame is addressed to another agent")
        payload = json.dumps(
            {"accepted_intent": request.intent, "payload_bytes": len(request.payload)},
            separators=(",", ":"),
            sort_keys=True,
        ).encode("utf-8")
        return pack(
            Envelope(
                intent=STATUS_INTENT,
                from_agent=self.name,
                to_agent=request.from_agent,
                task_id=request.task_id,
                timestamp_ms=request.timestamp_ms + 1,
                payload=payload,
            )
        )


def run_golden_vector_agent_demo(path: Path = DEFAULT_VECTORS) -> list[Envelope]:
    fixture = json.loads(path.read_text(encoding="utf-8"))
    replies: list[Envelope] = []
    for vector in fixture["vectors"]:
        request_frame = bytes.fromhex(vector["envelope_hex"])
        request = unpack(request_frame)
        if request.payload.hex() != vector["payload_hex"]:
            raise ValueError(f"golden payload mismatch: {vector['name']}")
        reply = unpack(GoldenVectorAgent(request.to_agent).handle(request_frame))
        if reply.to_agent != request.from_agent or reply.task_id != request.task_id:
            raise ValueError(f"reply correlation mismatch: {vector['name']}")
        replies.append(reply)
    return replies


def _read_agent(frame: bytes, cursor: int) -> tuple[str, int]:
    if cursor + 2 > len(frame):
        raise ValueError("truncated RACP agent length")
    length = struct.unpack_from(">H", frame, cursor)[0]
    cursor += 2
    if cursor + length > len(frame):
        raise ValueError("truncated RACP agent name")
    try:
        value = frame[cursor : cursor + length].decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("invalid RACP agent UTF-8") from error
    _agent_bytes(value)
    return value, cursor + length


def _agent_bytes(value: str) -> bytes:
    encoded = value.encode("utf-8")
    if not AGENT_NAME.fullmatch(value) or not 2 <= len(encoded) <= 64:
        raise ValueError("invalid canonical RACP agent name")
    return encoded


if __name__ == "__main__":
    responses = run_golden_vector_agent_demo()
    print(f"verified {len(responses)} golden requests and replies")
