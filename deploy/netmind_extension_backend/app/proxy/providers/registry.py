"""Name → handler lookup for the provisioning routes."""
from app.core.errors import HandlerNotFoundError
from app.proxy.providers.base import HandlerKind, SecretHandler

_handlers: dict[str, SecretHandler] = {}


def register(handler: SecretHandler, *, replace: bool = False) -> None:
    if handler.name in _handlers and not replace:
        raise ValueError(f"handler '{handler.name}' is already registered")
    _handlers[handler.name] = handler


def get(name: str, kind: HandlerKind) -> SecretHandler:
    handler = _handlers.get(name)
    if handler is None or handler.kind != kind:
        raise HandlerNotFoundError(f"no {kind} handler registered for '{name}'")
    return handler


def names_by_kind(kind: HandlerKind) -> list[str]:
    return sorted(name for name, h in _handlers.items() if h.kind == kind)


def _reset_for_tests() -> None:
    _handlers.clear()
