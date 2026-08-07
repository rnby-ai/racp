import hashlib
import json
import struct
import unittest
import uuid
from pathlib import Path


FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "vectors"
    / "racp-v1-golden-vectors.json"
)


def decode_frame(frame: bytes):
    if frame[:4] != b"RACP":
        raise ValueError("invalid magic")
    version, intent = frame[4], frame[5]
    cursor = 6
    from_length = struct.unpack_from(">H", frame, cursor)[0]
    cursor += 2
    from_agent = frame[cursor : cursor + from_length].decode("utf-8")
    cursor += from_length
    to_length = struct.unpack_from(">H", frame, cursor)[0]
    cursor += 2
    to_agent = frame[cursor : cursor + to_length].decode("utf-8")
    cursor += to_length
    task_bytes = frame[cursor : cursor + 16]
    task_id = None if task_bytes == bytes(16) else str(uuid.UUID(bytes=task_bytes))
    cursor += 16
    timestamp_ms = struct.unpack_from(">Q", frame, cursor)[0]
    cursor += 8
    wire_hash = frame[cursor : cursor + 8]
    cursor += 8
    payload_length = struct.unpack_from(">H", frame, cursor)[0]
    cursor += 2
    payload = frame[cursor : cursor + payload_length]
    if cursor + payload_length != len(frame):
        raise ValueError("trailing or missing payload bytes")
    return {
        "version": version,
        "intent": intent,
        "from_agent": from_agent,
        "to_agent": to_agent,
        "task_id": task_id,
        "timestamp_ms": timestamp_ms,
        "wire_hash": wire_hash,
        "payload": payload,
    }


class GoldenVectorTest(unittest.TestCase):
    def test_python_decoder_matches_every_language_neutral_vector(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual(fixture["format"], "racp-v1-sha256-inline")
        self.assertEqual(fixture["hash_algorithm"], "SHA-256")

        for vector in fixture["vectors"]:
            with self.subTest(vector=vector["name"]):
                frame = bytes.fromhex(vector["envelope_hex"])
                decoded = decode_frame(frame)
                payload = bytes.fromhex(vector["payload_hex"])
                digest = hashlib.sha256(payload).digest()
                self.assertEqual(decoded["version"], fixture["wire_version"])
                self.assertEqual(decoded["intent"], vector["intent_code"])
                self.assertEqual(decoded["from_agent"], vector["from_agent"])
                self.assertEqual(decoded["to_agent"], vector["to_agent"])
                self.assertEqual(decoded["task_id"], vector["task_id"])
                self.assertEqual(decoded["timestamp_ms"], int(vector["timestamp_ms"]))
                self.assertEqual(decoded["payload"], payload)
                self.assertEqual(digest.hex(), vector["payload_sha256_hex"])
                self.assertEqual(decoded["wire_hash"], digest[:8])
                self.assertEqual(decoded["wire_hash"].hex(), vector["wire_hash_prefix_hex"])


if __name__ == "__main__":
    unittest.main()
