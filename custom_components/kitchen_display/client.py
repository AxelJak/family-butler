"""Async client for the Kitchen Display Pi API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aiohttp import ClientError, ClientResponseError, ClientSession, ClientTimeout
from homeassistant.exceptions import HomeAssistantError

TIMEOUT = ClientTimeout(total=10, connect=5)


class KitchenDisplayError(HomeAssistantError):
    """Base API error."""


class KitchenDisplayAuthError(KitchenDisplayError):
    """Authentication failed."""


class KitchenDisplayConnectionError(KitchenDisplayError):
    """The display could not be reached."""


class KitchenDisplayResponseError(KitchenDisplayError):
    """The display rejected a request."""


@dataclass(slots=True)
class KitchenDisplayClient:
    """Small, bounded aiohttp API client."""

    session: ClientSession
    base_url: str
    token: str

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")

    async def _request(self, method: str, path: str, json: dict[str, Any] | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.token}"}
        try:
            async with self.session.request(
                method, f"{self.base_url}{path}", json=json, headers=headers, timeout=TIMEOUT
            ) as response:
                if response.status in (401, 403):
                    raise KitchenDisplayAuthError("Authentication failed")
                response.raise_for_status()
                return await response.json(content_type=None)
        except KitchenDisplayAuthError:
            raise
        except ClientResponseError as err:
            raise KitchenDisplayResponseError(f"Display returned HTTP {err.status}") from err
        except (ClientError, TimeoutError) as err:
            raise KitchenDisplayConnectionError("Unable to connect to display") from err

    async def health(self) -> dict[str, Any]:
        return await self._request("GET", "/api/health")

    async def show(self, payload: dict[str, Any]) -> Any:
        return await self._request("POST", "/api/display", {"schemaVersion": 1, **payload})

    async def clear(self) -> Any:
        return await self._request("DELETE", "/api/display")

    async def put_timer(self, payload: dict[str, Any]) -> Any:
        return await self._request("PUT", "/api/timer", {"schemaVersion": 1, **payload})

    async def delete_timer(self) -> Any:
        return await self._request("DELETE", "/api/timer")
