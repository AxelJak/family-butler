"""End-to-end setup tests for the Kitchen Display config entry."""

from unittest.mock import AsyncMock, patch

import pytest
from homeassistant.helpers import llm
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.kitchen_display.const import DOMAIN


@pytest.mark.asyncio
async def test_setup_registers_actions_platform_and_llm_api(hass) -> None:
    hass.states.async_set("timer.kitchen", "idle", {"friendly_name": "Kitchen timer"})
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Kitchen Display",
        data={
            "base_url": "http://kitchen-display.local",
            "token": "test-token-that-is-at-least-32-characters",
            "timer_entity": "timer.kitchen",
        },
    )
    entry.add_to_hass(hass)

    with (
        patch(
            "custom_components.kitchen_display.client.KitchenDisplayClient.health",
            AsyncMock(return_value={"status": "ok"}),
        ),
        patch(
            "custom_components.kitchen_display.client.KitchenDisplayClient.delete_timer",
            AsyncMock(return_value={"view": {"type": "idle"}}),
        ),
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()

    for action in ("show_text", "show_recipe", "show_list", "show_timer", "clear_display"):
        assert hass.services.has_service(DOMAIN, action)
    assert "kitchen_display" in {api.id for api in llm.async_get_apis(hass)}
    assert hass.states.get("binary_sensor.kitchen_display_availability") is not None

    assert await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
    assert not hass.services.has_service(DOMAIN, "show_text")
    assert "kitchen_display" not in {api.id for api in llm.async_get_apis(hass)}
