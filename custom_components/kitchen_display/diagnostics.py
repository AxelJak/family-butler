"""Diagnostics for Kitchen Display."""

from homeassistant.components.diagnostics import async_redact_data

from .const import CONF_TOKEN


async def async_get_config_entry_diagnostics(hass, entry):
    return {
        "config": async_redact_data(dict(entry.data), {CONF_TOKEN}),
        "available": entry.runtime_data.last_update_success,
    }
