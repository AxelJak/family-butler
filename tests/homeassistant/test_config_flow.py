"""Tests for config validation."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.kitchen_display.config_flow import validate_input


@pytest.mark.asyncio
async def test_validate_rejects_bad_url_and_missing_timer() -> None:
    hass = MagicMock()
    with pytest.raises(ValueError, match="invalid_url"):
        await validate_input(hass, {"base_url": "display", "token": "x", "timer_entity": "timer.kitchen"})

    hass.states.get.return_value = None
    with pytest.raises(ValueError, match="invalid_timer"):
        await validate_input(hass, {"base_url": "http://display", "token": "x", "timer_entity": "timer.kitchen"})


@pytest.mark.asyncio
async def test_validate_calls_public_health() -> None:
    hass = MagicMock()
    hass.states.get.return_value = MagicMock()
    with patch("custom_components.kitchen_display.config_flow.KitchenDisplayClient") as client:
        client.return_value.health = AsyncMock(return_value={"ok": True})
        await validate_input(hass, {"base_url": "http://display/", "token": "x", "timer_entity": "timer.kitchen"})
        client.return_value.health.assert_awaited_once_with()
