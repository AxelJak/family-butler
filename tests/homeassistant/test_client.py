"""Tests for the Pi API client."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from custom_components.kitchen_display.client import KitchenDisplayAuthError, KitchenDisplayClient


@pytest.mark.asyncio
async def test_mutation_shape_and_auth() -> None:
    response = MagicMock()
    response.status = 200
    response.json = AsyncMock(return_value={"ok": True})
    response.raise_for_status = MagicMock()
    context = AsyncMock()
    context.__aenter__.return_value = response
    session = MagicMock()
    session.request.return_value = context

    await KitchenDisplayClient(session, "http://display/", "secret").show({"type": "text", "text": "hello"})

    _, kwargs = session.request.call_args
    assert kwargs["json"] == {"schemaVersion": 1, "type": "text", "text": "hello"}
    assert kwargs["headers"] == {"Authorization": "Bearer secret"}


@pytest.mark.asyncio
async def test_health_also_sends_auth_for_token_validation() -> None:
    response = MagicMock(status=200)
    response.json = AsyncMock(return_value={"status": "ok"})
    response.raise_for_status = MagicMock()
    context = AsyncMock()
    context.__aenter__.return_value = response
    session = MagicMock()
    session.request.return_value = context

    await KitchenDisplayClient(session, "http://display", "secret").health()

    _, kwargs = session.request.call_args
    assert kwargs["headers"] == {"Authorization": "Bearer secret"}


@pytest.mark.asyncio
async def test_auth_error_mapping() -> None:
    response = MagicMock(status=401)
    context = AsyncMock()
    context.__aenter__.return_value = response
    session = MagicMock()
    session.request.return_value = context
    with pytest.raises(KitchenDisplayAuthError):
        await KitchenDisplayClient(session, "http://display", "bad").clear()
