"""Shared Kitchen Display runtime behavior."""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from homeassistant.components.timer import STATUS_ACTIVE, STATUS_IDLE, STATUS_PAUSED
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, State
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .client import KitchenDisplayClient, KitchenDisplayError

_LOGGER = logging.getLogger(__name__)


class KitchenDisplayRuntime:
    """Own API commands and mapping of the selected HA timer."""

    def __init__(self, hass: HomeAssistant, client: KitchenDisplayClient, timer_entity: str) -> None:
        self.hass = hass
        self.client = client
        self.timer_entity = timer_entity
        self.timer_name: str | None = None

    def _name(self, state: State | None) -> str:
        return self.timer_name or (state.attributes.get("friendly_name") if state else None) or "Timer"

    async def show_text(self, text: str, title: str | None = None, timeout_seconds: int | None = None) -> Any:
        payload = {"type": "text", "text": text}
        if title is not None:
            payload["title"] = title
        if timeout_seconds is not None:
            payload["timeoutSeconds"] = timeout_seconds
        return await self.client.show(payload)

    async def show_recipe(
        self,
        title: str,
        ingredients: list[str],
        steps: list[str],
        cooking_time_minutes: int | None = None,
        timeout_seconds: int | None = None,
    ) -> Any:
        payload: dict[str, Any] = {"type": "recipe", "title": title, "ingredients": ingredients, "steps": steps}
        if cooking_time_minutes is not None:
            payload["cookingTimeMinutes"] = cooking_time_minutes
        if timeout_seconds is not None:
            payload["timeoutSeconds"] = timeout_seconds
        return await self.client.show(payload)

    async def show_list(self, title: str, items: list[str], timeout_seconds: int | None = None) -> Any:
        payload: dict[str, Any] = {"type": "list", "title": title, "items": items}
        if timeout_seconds is not None:
            payload["timeoutSeconds"] = timeout_seconds
        return await self.client.show(payload)

    async def show_timer(self, name: str, duration_seconds: int) -> Any:
        self.timer_name = name
        await self.hass.services.async_call(
            "timer", "start", {ATTR_ENTITY_ID: self.timer_entity, "duration": duration_seconds}, blocking=True
        )
        state = self.hass.states.get(self.timer_entity)
        if state is None:
            raise HomeAssistantError("Configured timer helper is unavailable")
        await self.sync_timer(state)
        return await self.client.show(
            {"type": "timer", "name": name, "status": "active", "endsAt": self._ends_at(state)}
        )

    async def clear_display(self) -> Any:
        return await self.client.clear()

    @staticmethod
    def _ends_at(state: State) -> str:
        finishes = state.attributes.get("finishes_at")
        if not finishes:
            raise HomeAssistantError("Active timer has no finish time")
        parsed = datetime.fromisoformat(str(finishes).replace("Z", "+00:00"))
        return parsed.astimezone(UTC).isoformat().replace("+00:00", "Z")

    async def sync_timer(self, state: State | None) -> None:
        if state is None:
            self.timer_name = None
            await self.client.delete_timer()
        elif state.state == STATUS_IDLE:
            # Natural finish and cancellation have dedicated events. Ignoring the
            # resulting idle state prevents it from overwriting "finished".
            return
        elif state.state == STATUS_ACTIVE:
            await self.client.put_timer({"name": self._name(state), "status": "active", "endsAt": self._ends_at(state)})
        elif state.state == STATUS_PAUSED:
            remaining = state.attributes.get("remaining", "0:00:00")
            seconds = self._remaining_seconds(str(remaining))
            await self.client.put_timer({"name": self._name(state), "status": "paused", "remainingSeconds": seconds})

    async def timer_finished(self) -> None:
        name = self._name(self.hass.states.get(self.timer_entity))
        await self.client.put_timer({"name": name, "status": "finished"})
        self.timer_name = None

    async def timer_cancelled(self) -> None:
        self.timer_name = None
        await self.client.delete_timer()

    @staticmethod
    def _remaining_seconds(value: str) -> int:
        days = 0
        time_value = value
        if ", " in value:
            day_value, time_value = value.split(", ", maxsplit=1)
            days = int(day_value.split(maxsplit=1)[0])
        parts = time_value.split(":")
        if len(parts) != 3:
            raise HomeAssistantError("Paused timer has an invalid remaining time")
        hours, minutes, seconds = (int(float(part)) for part in parts)
        return days * 86400 + hours * 3600 + minutes * 60 + seconds

    async def reconcile_timer(self) -> None:
        """Push authoritative current state during setup or recovery."""
        state = self.hass.states.get(self.timer_entity)
        if state is None or state.state == STATUS_IDLE:
            self.timer_name = None
            await self.client.delete_timer()
        else:
            await self.sync_timer(state)


class KitchenDisplayCoordinator(DataUpdateCoordinator[bool]):
    """Poll public health and reconcile timer whenever connectivity recovers."""

    def __init__(self, hass: HomeAssistant, runtime: KitchenDisplayRuntime) -> None:
        super().__init__(hass, logger=_LOGGER, name="Kitchen Display", update_interval=timedelta(seconds=30))
        self.runtime = runtime
        self._needs_reconcile = True

    async def _async_update_data(self) -> bool:
        try:
            await self.runtime.client.health()
            if self._needs_reconcile or not self.last_update_success:
                await self.runtime.reconcile_timer()
                self._needs_reconcile = False
        except KitchenDisplayError as err:
            raise UpdateFailed("Unable to reach Kitchen Display") from err
        return True
