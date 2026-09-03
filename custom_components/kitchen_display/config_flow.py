"""Config flow for Kitchen Display."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant import config_entries
from homeassistant.helpers import selector
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import KitchenDisplayAuthError, KitchenDisplayClient, KitchenDisplayError
from .const import CONF_BASE_URL, CONF_TIMER_ENTITY, CONF_TOKEN, DOMAIN


def _schema(defaults: dict[str, Any] | None = None) -> vol.Schema:
    defaults = defaults or {}
    return vol.Schema(
        {
            vol.Required(CONF_BASE_URL, default=defaults.get(CONF_BASE_URL, "http://kitchen-display.local")): str,
            vol.Required(CONF_TOKEN, default=defaults.get(CONF_TOKEN, "")): vol.All(str, vol.Length(min=32)),
            vol.Required(CONF_TIMER_ENTITY, default=defaults.get(CONF_TIMER_ENTITY)): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="timer")
            ),
        }
    )


async def validate_input(hass, data: dict[str, Any]) -> None:
    """Validate URL and connectivity without exposing credentials."""
    url = data[CONF_BASE_URL].strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        raise ValueError("invalid_url")
    if not data[CONF_TIMER_ENTITY].startswith("timer.") or hass.states.get(data[CONF_TIMER_ENTITY]) is None:
        raise ValueError("invalid_timer")
    await KitchenDisplayClient(async_get_clientsession(hass), url, data[CONF_TOKEN]).health()


class KitchenDisplayConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Configure one Kitchen Display."""

    VERSION = 1

    async def async_step_user(self, user_input=None):
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        errors = {}
        if user_input is not None:
            try:
                await validate_input(self.hass, user_input)
            except ValueError as err:
                errors["base"] = str(err)
            except KitchenDisplayAuthError:
                errors["base"] = "invalid_auth"
            except KitchenDisplayError:
                errors["base"] = "cannot_connect"
            else:
                user_input[CONF_BASE_URL] = user_input[CONF_BASE_URL].strip().rstrip("/")
                return self.async_create_entry(title="Kitchen Display", data=user_input)
        return self.async_show_form(step_id="user", data_schema=_schema(user_input), errors=errors)

    async def async_step_reconfigure(self, user_input=None):
        entry = self._get_reconfigure_entry()
        errors = {}
        if user_input is not None:
            try:
                await validate_input(self.hass, user_input)
            except ValueError as err:
                errors["base"] = str(err)
            except KitchenDisplayAuthError:
                errors["base"] = "invalid_auth"
            except KitchenDisplayError:
                errors["base"] = "cannot_connect"
            else:
                user_input[CONF_BASE_URL] = user_input[CONF_BASE_URL].strip().rstrip("/")
                return self.async_update_reload_and_abort(entry, data=user_input)
        return self.async_show_form(step_id="reconfigure", data_schema=_schema(dict(entry.data)), errors=errors)
