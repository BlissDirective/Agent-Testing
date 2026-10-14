#!/usr/bin/env python3
"""Redact auth material from a HAR file before it goes into ./target.

Usage: python3 tools/redact_har.py in.har target/clean.har

Replaces values with "[REDACTED]" (names are kept, so the auth mechanism
is still visible) in:
  - request/response headers and cookies
  - query string params (both queryString[] and the URL itself)
  - form and JSON request bodies, JSON response bodies
  - WebSocket messages (Chrome's _webSocketMessages)
Any JWT or "Bearer <token>" left anywhere in text is also scrubbed.

This is a best-effort filter. Skim the output before sharing it.
"""

import base64
import json
import re
import sys
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

PLACEHOLDER = "[REDACTED]"

# Matched against header, cookie, param and JSON key names (case-insensitive).
# "auth(?!ority)" keeps the HTTP/2 ":authority" pseudo-header.
SENSITIVE_NAME = re.compile(
    r"auth(?!ority)|token|session|sess_?id|^sid$|secret|api[-_]?key|csrf|xsrf"
    r"|passw|^pwd$|signature|jwt|bearer|credential|cookie|^otp$|code_verifier",
    re.IGNORECASE,
)

# Matched against free text (bodies, URLs, header values of any name).
SENSITIVE_VALUE = [
    re.compile(r"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"),  # JWT
    re.compile(r"(?i)(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"),
]

counts = {"headers": 0, "cookies": 0, "params": 0, "body_fields": 0, "patterns": 0}


def is_sensitive(name):
    return bool(name and SENSITIVE_NAME.search(name))


def scrub_text(text):
    for pattern in SENSITIVE_VALUE:
        text, n = pattern.subn(
            lambda m: f"{m.group(1)} {PLACEHOLDER}" if m.lastindex else PLACEHOLDER,
            text,
        )
        counts["patterns"] += n
    return text


def redact_pairs(pairs, kind):
    """Redact a HAR list of {"name": ..., "value": ...} objects in place."""
    for pair in pairs or []:
        if is_sensitive(pair.get("name")):
            pair["value"] = PLACEHOLDER
            counts[kind] += 1
        elif isinstance(pair.get("value"), str):
            pair["value"] = scrub_text(pair["value"])


def redact_json(node):
    if isinstance(node, dict):
        for key, value in node.items():
            if is_sensitive(key) and not isinstance(value, (dict, list)):
                node[key] = PLACEHOLDER
                counts["body_fields"] += 1
            else:
                node[key] = redact_json(value)
    elif isinstance(node, list):
        return [redact_json(item) for item in node]
    elif isinstance(node, str):
        return scrub_text(node)
    return node


def redact_query(query):
    pairs = []
    for name, value in parse_qsl(query, keep_blank_values=True):
        if is_sensitive(name):
            value = PLACEHOLDER
            counts["params"] += 1
        pairs.append((name, value))
    return urlencode(pairs, safe="[]")


def redact_url(url):
    parts = urlsplit(url)
    if not parts.query:
        return scrub_text(url)
    return scrub_text(urlunsplit(parts._replace(query=redact_query(parts.query))))


def redact_body(text, mime_type):
    mime_type = (mime_type or "").lower()
    if "json" in mime_type:
        try:
            return json.dumps(redact_json(json.loads(text)), ensure_ascii=False)
        except ValueError:
            pass
    if "x-www-form-urlencoded" in mime_type:
        return redact_query(text)
    return scrub_text(text)


def redact_content(content):
    """Response bodies; base64 ones are only touched if they decode as UTF-8."""
    text = content.get("text")
    if not text:
        return
    if content.get("encoding") == "base64":
        try:
            decoded = base64.b64decode(text).decode("utf-8")
        except ValueError:
            return
        redacted = redact_body(decoded, content.get("mimeType"))
        content["text"] = base64.b64encode(redacted.encode("utf-8")).decode("ascii")
    else:
        content["text"] = redact_body(text, content.get("mimeType"))


def redact_entry(entry):
    request = entry.get("request", {})
    response = entry.get("response", {})

    request["url"] = redact_url(request.get("url", ""))
    for message in (request, response):
        redact_pairs(message.get("headers"), "headers")
        redact_pairs(message.get("cookies"), "cookies")
    redact_pairs(request.get("queryString"), "params")

    post = request.get("postData")
    if post:
        redact_pairs(post.get("params"), "params")
        if post.get("text"):
            post["text"] = redact_body(post["text"], post.get("mimeType"))

    redact_content(response.get("content", {}))
    if response.get("redirectURL"):
        response["redirectURL"] = redact_url(response["redirectURL"])

    for message in entry.get("_webSocketMessages") or []:
        if isinstance(message.get("data"), str):
            message["data"] = redact_body(message["data"], "application/json")


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.split("\n\n")[1])
    src, dst = sys.argv[1], sys.argv[2]
    if src == dst:
        sys.exit("Refusing to overwrite the input file.")

    with open(src, encoding="utf-8") as f:
        har = json.load(f)
    entries = har.get("log", {}).get("entries", [])
    for entry in entries:
        redact_entry(entry)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(har, f, indent=2, ensure_ascii=False)

    summary = ", ".join(f"{n} {kind}" for kind, n in counts.items())
    print(f"{len(entries)} entries written to {dst}. Redacted: {summary}.")


if __name__ == "__main__":
    main()
