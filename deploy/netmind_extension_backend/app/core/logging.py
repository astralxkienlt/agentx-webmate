"""Structured logging — loguru, one pipe-delimited line per record.

    2026-08-19 09:12:00.123 | INFO    | req=ab12cd34 | app.request:dispatch:57 \
        - [HTTP] extension POST /v1/provision-keys/litellm -> 200 84ms

Every record emitted while handling one request shares `req=<rid>`, so grepping
a single rid reconstructs the whole trace. Secrets are scrubbed before write:
model keys are the one thing in this service that must never reach a log file,
because a log file is exactly the artefact that gets pasted into a ticket.
"""
import logging
import re
import sys
import time
from pathlib import Path
from uuid import uuid4

from loguru import logger
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from app.core.config import settings

# The length floor matters: without it this pattern also eats the word after any
# occurrence of "bearer", including the HTTP method in an access line reading
# `[HTTP] bearer POST /path`. Real credentials are far longer than 16
# characters, so the floor costs nothing and keeps log lines honest.
_BEARER_RE = re.compile(r"(Bearer\s+)[\w\-.~+/=]{16,}", re.IGNORECASE)
_KEY_RE = re.compile(r"sk-[\w\-]{6,}")
# A raw JWT anywhere in a message — three base64url segments. ID tokens carry
# the user's email and name, so an unscrubbed one turns a log into PII.
_JWT_RE = re.compile(r"\beyJ[\w\-]+\.[\w\-]+\.[\w\-]+")

_FMT = (
    "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <7} | req={extra[rid]} | "
    "{name}:{function}:{line} - {message}"
)


def _scrub(record: dict) -> None:
    msg = record["message"]
    msg = _BEARER_RE.sub(r"\1<redacted>", msg)
    msg = _KEY_RE.sub("sk-<redacted>", msg)
    msg = _JWT_RE.sub("<jwt-redacted>", msg)
    # One record = one physical line, so `grep ERROR app.log` returns whole
    # records rather than continuation fragments.
    msg = msg.replace("\n", "\\n").replace("\r", "")
    record["message"] = msg


def mask_key(value: str) -> str:
    """A model key rendered safe for logs: prefix + last 4, never the middle."""
    if not value:
        return "<empty>"
    if len(value) <= 12:
        return "sk-<redacted>"
    return f"{value[:6]}…{value[-4:]}"


def _classify_source(request: Request) -> str:
    # Labels are deliberately not the word "bearer": the scrubber rewrites what
    # follows that word, and a source label sitting next to the HTTP method in
    # the access line would get the method redacted instead of a credential.
    if request.headers.get("x-agentx-device"):
        return "extension"
    if request.headers.get("x-auth-key"):
        return "ingest-key"
    if request.headers.get("authorization"):
        return "token"
    return "anonymous"


class RequestLogMiddleware(BaseHTTPMiddleware):
    """Bind a per-request id for the whole request, emit one access line."""

    async def dispatch(self, request: Request, call_next):
        # The container healthcheck hits /health every few seconds; logging it
        # buries everything else.
        if request.url.path.endswith("/health"):
            return await call_next(request)

        rid = uuid4().hex[:8]
        with logger.contextualize(rid=rid):
            source = _classify_source(request)
            start = time.perf_counter()
            status = 500
            try:
                response = await call_next(request)
                status = response.status_code
                response.headers["x-request-id"] = rid
                return response
            finally:
                ms = (time.perf_counter() - start) * 1000
                logger.info(
                    f"[HTTP] {source} {request.method} {request.url.path} "
                    f"-> {status} {ms:.0f}ms"
                )


def configure_logging() -> None:
    """Wire loguru → stdout + rotating file; silence uvicorn's own access log.

    Idempotent: `logger.remove()` drops prior sinks so repeated calls (reload,
    tests) don't stack duplicates.
    """
    logger.remove()
    logger.configure(patcher=_scrub, extra={"rid": "-"})

    logger.add(
        sys.stdout,
        level=settings.log_level,
        format=_FMT,
        backtrace=False,
        diagnose=False,
        enqueue=True,
    )
    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    logger.add(
        log_dir / "app.log",
        level=settings.log_level,
        format=_FMT,
        rotation="50 MB",
        retention="14 days",
        backtrace=False,
        diagnose=False,
        enqueue=True,
    )
    # uvicorn's access line has no rid and duplicates ours.
    logging.getLogger("uvicorn.access").disabled = True
