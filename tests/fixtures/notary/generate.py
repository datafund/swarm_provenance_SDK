"""
Generate notary-signed fixture documents with the gateway's own signing code.

Run from a swarm_connect checkout (its venv has eth_account):

    cd ../swarm_connect && NOTARY_ENABLED=true \
      venv/bin/python ../swarm_provenance_SDK/tests/fixtures/notary/generate.py \
      ../swarm_provenance_SDK/tests/fixtures/notary

Uses Hardhat account #0, a publicly known test key. Output files are the exact
JSON text the gateway stores (json.dumps(..., indent=2)).
"""
import base64
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from app.services.provenance import ProvenanceService
from app.services.signing import SigningService

HARDHAT_0_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
TIMESTAMP = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)

out_dir = Path(sys.argv[1])
service = ProvenanceService(SigningService(HARDHAT_0_KEY))


def sign(name: str, document: dict) -> None:
    signed = service.sign_document(json.dumps(document).encode("utf-8"), TIMESTAMP)
    (out_dir / f"{name}.json").write_text(signed.raw_json)
    print(name, signed.signatures[-1]["signer"])


# 1. Default (base64) upload, as ProvenanceClient.upload() builds it
content = "hello provenance — ünïcode ✓".encode("utf-8")
sign("base64-document", {
    "data": base64.b64encode(content).decode("ascii"),
    "content_hash": hashlib.sha256(content).hexdigest(),
    "stamp_id": "a" * 64,
})

# 2. Raw JSON document with everything canonicalisation can get wrong:
#    unsorted keys, non-ASCII and astral characters, control characters,
#    floats Python and JS format differently, an integer beyond 2^53.
raw_data = {
    "zeta": 1,
    "alpha": {"b": [1, 2.0, 0.1, 1e16, 1.5e-7, -0.0, 123456789012345678901234567890], "a": None},
    "text": "quote\" backslash\\ slash/ tab\t newline\n del\x7f é 日本 😀",
    "ékey": True,
    "\U0001F600": "astral key",
    "Ａ": "BMP key above the surrogate range",
    "empty": {},
    "list": [],
}
canonical = json.dumps(raw_data, sort_keys=True, separators=(",", ":"))
sign("raw-document", {
    "data": raw_data,
    "content_hash": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    "stamp_id": "b" * 64,
})
(out_dir / "raw-document.canonical.txt").write_text(canonical)
