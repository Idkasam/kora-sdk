"""Error classes for the Kora SDK."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .types import AuthorizationResult, DenialObject


class KoraError(Exception):
    """Base error for Kora SDK operations."""

    def __init__(self, code: str, message: str, status_code: int):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class KoraDenialError(KoraError):
    """Raised when an authorization is denied (optional — denials are also returned as results)."""

    def __init__(self, result: AuthorizationResult):
        message = (
            result.denial.message
            if result.denial
            else f"Authorization denied: {result.reason_code}"
        )
        super().__init__(result.reason_code, message, 200)
        self.denial: DenialObject | None = result.denial
        self.result: AuthorizationResult = result
