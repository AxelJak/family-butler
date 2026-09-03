"""Tests for Home Assistant timer mapping."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from homeassistant.core import State

from custom_components.kitchen_display.runtime import KitchenDisplayCoordinator, KitchenDisplayRuntime


@pytest.mark.asyncio
async def test_active_paused_and_idle_timer_mapping() -> None:
    client = AsyncMock()
    runtime = KitchenDisplayRuntime(MagicMock(), client, "timer.kitchen")
    runtime.timer_name = "Pasta"

    await runtime.sync_timer(State("timer.kitchen", "active", {"finishes_at": "2026-09-03T10:00:00+00:00"}))
    client.put_timer.assert_awaited_with({"name": "Pasta", "status": "active", "endsAt": "2026-09-03T10:00:00Z"})

    await runtime.sync_timer(State("timer.kitchen", "paused", {"remaining": "0:02:03"}))
    client.put_timer.assert_awaited_with({"name": "Pasta", "status": "paused", "remainingSeconds": 123})

    await runtime.sync_timer(State("timer.kitchen", "paused", {"remaining": "1 day, 0:00:00"}))
    client.put_timer.assert_awaited_with({"name": "Pasta", "status": "paused", "remainingSeconds": 86400})

    await runtime.sync_timer(State("timer.kitchen", "idle"))
    client.delete_timer.assert_not_awaited()


@pytest.mark.asyncio
async def test_finished_uses_dedicated_mapping() -> None:
    client = AsyncMock()
    hass = MagicMock()
    hass.states.get.return_value = State("timer.kitchen", "idle", {"friendly_name": "Kitchen timer"})
    runtime = KitchenDisplayRuntime(hass, client, "timer.kitchen")
    runtime.timer_name = "Kakan"
    await runtime.timer_finished()
    client.put_timer.assert_awaited_once_with({"name": "Kakan", "status": "finished"})
    assert runtime.timer_name is None


@pytest.mark.asyncio
async def test_cancelled_clears_custom_name_and_display_timer() -> None:
    client = AsyncMock()
    runtime = KitchenDisplayRuntime(MagicMock(), client, "timer.kitchen")
    runtime.timer_name = "Pasta"

    await runtime.timer_cancelled()

    assert runtime.timer_name is None
    client.delete_timer.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_coordinator_reconciles_timer_on_first_health_check(hass) -> None:
    runtime = MagicMock()
    runtime.client.health = AsyncMock(return_value={"status": "ok"})
    runtime.reconcile_timer = AsyncMock()
    coordinator = KitchenDisplayCoordinator(hass, runtime)

    result = await coordinator._async_update_data()

    assert result is True
    runtime.client.health.assert_awaited_once_with()
    runtime.reconcile_timer.assert_awaited_once_with()
