#!/usr/bin/env python3
"""Legacy Fact-string checks plus a reusable pdftotext extraction boundary.

argv[1]: absolute path of the compiled PDF.
stdin: {"identity": [str], "roles": [{"company", "position", "date"}], "skills": [str]}
stdout: {"verdict": "PASS" | "FAIL", "missing": [{"kind", "token"}],
         "order": [str], "error": str | null}

The legacy ``check`` function owns its text normalization, whole-token, and
order semantics; the strict PDF evaluator reuses only ``extract`` and
``normalize``. A token matches only where it is not glued to another letter or
digit, so a one-letter skill such as `C` never matches inside another word.

``extract`` is also the small reusable pdftotext boundary used by the strict
PDF evaluator. The legacy ``check`` flow below deliberately retains its
existing matching semantics and output contract.
"""
import json
import re
import subprocess
import sys

FOLD = str.maketrans({
    "–": "-", "—": "-",          # en dash, em dash
    "‘": "'", "’": "'",          # curly single quotes
    "“": '"', "”": '"',          # curly double quotes
})
WHITESPACE = re.compile(r"\s+")
ROLE_KEYS = ("company", "position", "date")


def normalize(text):
    """Fold dashes and quotes, then collapse whitespace so wrapped lines compare equal."""
    return WHITESPACE.sub(" ", text.translate(FOLD).replace("--", "-")).strip()


def check(text, expected):
    """Return the verdict payload for extracted text against expected strings."""
    hay = normalize(text)
    missing = []
    order = []

    def find(token, start=0):
        """Return where the token appears as a whole word, or -1."""
        needle = normalize(token)
        if not needle:
            return -1
        pattern = re.compile(
            r"(?<![^\W_])" + re.escape(needle) + r"(?![^\W_])"
        )
        match = pattern.search(hay, start)
        return match.start() if match else -1

    def require(kind, token, cursor):
        anchor = find(token, cursor)
        if anchor >= 0:
            return anchor + len(normalize(token))
        if find(token) >= 0:
            order.append(f"{kind} {token!r} prints before the preceding role")
        else:
            missing.append({"kind": kind, "token": token})
        return cursor

    for token in expected["identity"]:
        if normalize(token):
            require("identity", token, 0)

    cursor = 0
    for role in expected["roles"]:
        cursor = max(
            require(kind, role[kind], cursor)
            for kind in ROLE_KEYS
        )

    for token in expected["skills"]:
        require("skill", token, 0)

    return {
        "verdict": "PASS" if not missing and not order else "FAIL",
        "missing": missing,
        "order": order,
        "error": None,
    }


def _error(message):
    return {"verdict": "FAIL", "missing": [], "order": [], "error": message}


def _shape_error(expected):
    """Return a message when the expectation payload is malformed, else None."""
    if not isinstance(expected, dict):
        return "expected must be an object"
    for key in ("identity", "skills"):
        value = expected.get(key)
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            return f"{key} must be an array of strings"
    roles = expected.get("roles")
    if not isinstance(roles, list):
        return "roles must be an array"
    for index, role in enumerate(roles):
        if not isinstance(role, dict) or any(
            not isinstance(role.get(k), str) for k in ROLE_KEYS
        ):
            return f"roles[{index}] must carry string company, position, date"
    return None


def extract(pdf_path, layout=False):
    """Return pdftotext text for the PDF, optionally using ``-layout``.

    Keep the subprocess boundary explicit and bounded so callers can safely
    reuse it for diagnostics. ``FileNotFoundError`` remains distinct for the
    legacy CLI's existing message; decode and timeout failures are represented
    as ``RuntimeError`` and are handled by that same CLI.
    """
    command = ["pdftotext", "-enc", "UTF-8", "-eol", "unix"]
    if layout:
        command.append("-layout")
    command.extend([pdf_path, "-"])
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("pdftotext timed out") from error
    except UnicodeDecodeError as error:
        raise RuntimeError("invalid UTF-8 output") from error
    if result.returncode != 0:
        raise RuntimeError(f"pdftotext failed: {result.stderr.strip()}")
    return result.stdout


def main():
    try:
        expected = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        _emit(_error(f"invalid JSON: {error}"))
        return 1

    message = _shape_error(expected)
    if message is None and len(sys.argv) != 2:
        message = "usage: check_parse.py <pdf>"
    if message is not None:
        _emit(_error(message))
        return 0

    try:
        text = extract(sys.argv[1])
    except FileNotFoundError:
        _emit(_error("pdftotext is not installed"))
        return 0
    except RuntimeError as error:
        _emit(_error(str(error)))
        return 0

    _emit(check(text, expected))
    return 0


def _emit(payload):
    json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    raise SystemExit(main())
