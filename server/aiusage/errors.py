from __future__ import annotations


class ProviderError(Exception):
    """업스트림 호출 실패. kind 로 위젯에 보여줄 상태를 구분한다."""

    kind = "error"

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


class AuthError(ProviderError):
    """토큰 만료·폐기 등으로 재로그인이 필요한 경우."""

    kind = "needs_login"


class RateLimitedError(ProviderError):
    kind = "rate_limited"


class BlockedError(ProviderError):
    """Cloudflare 챌린지 등으로 서버 IP에서 막힌 경우."""

    kind = "blocked"


class LoginError(Exception):
    """로그인 완료 단계에서 사용자 입력이나 토큰 교환이 잘못된 경우."""


class LoginNotFound(LoginError):
    """로그인 세션이 없거나 만료됐을 때. 클라이언트는 404 로 '처음부터 다시'를 알아본다."""
