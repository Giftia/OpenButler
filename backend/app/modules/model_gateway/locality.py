"""Bounded declarations from supported local providers, never offline attestation.

No prompt, image, model loading or inference is needed for these checks. A
loopback address and the absence of remote fields alone are not local evidence.
"""

import re


class LocalityError(Exception):
    """Content-free denial of an unverified local route."""


def _deny(code="local_model_unverified"):
    raise LocalityError(code)


def _no_remote(data):
    for field in ("remote_model", "remote_host"):
        if field in data:
            value = data[field]
            if type(value) is not str:
                _deny()
            if value:
                _deny("local_model_remote")


def _positive_int(value):
    return type(value) is int and 0 < value <= 2**63 - 1


def ollama_model_name(model):
    # Match the provider's explicit source selectors, in addition to checking
    # metadata. This is a deny rule, never a name-based locality allow rule.
    if (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model)
            or "//" in model or any(part in (".", "..") for part in model.split("/"))):
        _deny()
    suffix = model.rsplit(":", 1)[-1].lower()
    if ":" in model and (suffix == "cloud" or "/" not in suffix and suffix.endswith("-cloud")):
        _deny("local_model_remote")
    if suffix == "local":
        # The local selector is not supported on older providers. Do not
        # reinterpret a caller's model identity or rely on selector support.
        _deny()
    return model if ":" in model.rsplit("/", 1)[-1] else model + ":latest"


def require_ollama_local(data, model):
    expected = ollama_model_name(model)
    if type(data) is not dict:
        _deny()
    _no_remote(data)
    rows = data.get("models")
    if type(rows) is not list or len(rows) > 128:
        _deny()
    matched = []
    for row in rows:
        if type(row) is not dict or type(row.get("name")) is not str:
            _deny()
        if row["name"] in (model, expected):
            matched.append(row)
    # Multiple runner/alias rows are ambiguous; don't choose an arbitrary row.
    if len(matched) != 1:
        _deny()
    row = matched[0]
    _no_remote(row)
    if row.get("model") != row["name"]:
        _deny()
    details = row.get("details")
    if type(details) is not dict:
        _deny()
    _no_remote(details)
    if (details.get("format") not in ("gguf", "safetensors")
            or not _positive_int(row.get("size"))
            or type(row.get("digest")) is not str
            or not re.fullmatch(r"[0-9a-f]{64}", row["digest"])):
        _deny()
