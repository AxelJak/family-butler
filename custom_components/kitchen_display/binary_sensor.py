"""Availability diagnostic for Kitchen Display."""

from homeassistant.components.binary_sensor import BinarySensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity import EntityCategory
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .runtime import KitchenDisplayCoordinator


async def async_setup_entry(hass, entry: ConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback) -> None:
    async_add_entities([KitchenDisplayAvailability(entry.runtime_data)])


class KitchenDisplayAvailability(CoordinatorEntity[KitchenDisplayCoordinator], BinarySensorEntity):
    """Report whether the Pi health endpoint is responding."""

    _attr_has_entity_name = True
    _attr_translation_key = "availability"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:monitor-eye"
    _attr_device_info = DeviceInfo(
        identifiers={(DOMAIN, "server")},
        name="Kitchen Display",
        entry_type=DeviceEntryType.SERVICE,
    )

    def __init__(self, coordinator: KitchenDisplayCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = "kitchen_display_availability"

    @property
    def is_on(self) -> bool:
        return self.coordinator.last_update_success
