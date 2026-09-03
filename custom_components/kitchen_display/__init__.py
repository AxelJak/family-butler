"""Kitchen Display integration."""

from __future__ import annotations

from homeassistant.components.timer import EVENT_TIMER_CANCELLED, EVENT_TIMER_FINISHED
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import Event, HomeAssistant, ServiceCall
from homeassistant.helpers import llm as ha_llm
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.event import async_track_state_change_event

from .client import KitchenDisplayClient
from .const import CONF_BASE_URL, CONF_TIMER_ENTITY, CONF_TOKEN, DOMAIN, PLATFORMS
from .llm import SCHEMAS, KitchenDisplayAPI
from .runtime import KitchenDisplayCoordinator, KitchenDisplayRuntime


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up one Kitchen Display entry."""
    client = KitchenDisplayClient(async_get_clientsession(hass), entry.data[CONF_BASE_URL], entry.data[CONF_TOKEN])
    runtime = KitchenDisplayRuntime(hass, client, entry.data[CONF_TIMER_ENTITY])
    coordinator = KitchenDisplayCoordinator(hass, runtime)
    entry.runtime_data = coordinator

    await coordinator.async_config_entry_first_refresh()

    api = KitchenDisplayAPI(hass, runtime)
    entry.async_on_unload(ha_llm.async_register_api(hass, api))

    async def state_changed(event: Event) -> None:
        await runtime.sync_timer(event.data.get("new_state"))

    async def timer_finished(event: Event) -> None:
        if event.data.get(ATTR_ENTITY_ID) == runtime.timer_entity:
            await runtime.timer_finished()

    entry.async_on_unload(async_track_state_change_event(hass, [runtime.timer_entity], state_changed))
    entry.async_on_unload(hass.bus.async_listen(EVENT_TIMER_FINISHED, timer_finished))

    async def timer_cancelled(event: Event) -> None:
        if event.data.get(ATTR_ENTITY_ID) == runtime.timer_entity:
            await runtime.timer_cancelled()

    entry.async_on_unload(hass.bus.async_listen(EVENT_TIMER_CANCELLED, timer_cancelled))

    for name, schema in SCHEMAS.items():

        async def handle(call: ServiceCall, method=name) -> None:
            await getattr(runtime, method)(**call.data)

        hass.services.async_register(DOMAIN, name, handle, schema=schema)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload Kitchen Display and all global registrations."""
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    for name in SCHEMAS:
        hass.services.async_remove(DOMAIN, name)
    return True
