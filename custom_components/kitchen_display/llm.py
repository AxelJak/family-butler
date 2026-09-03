"""Kitchen Display LLM API and tools."""

from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.helpers import llm

from .const import MAX_ITEM_LENGTH, MAX_ITEMS, MAX_TEXT, MAX_TITLE
from .runtime import KitchenDisplayRuntime

SHORT = vol.All(str, vol.Length(min=1, max=MAX_TITLE))
ITEM = vol.All(str, vol.Length(min=1, max=MAX_ITEM_LENGTH))
ITEMS = vol.All([ITEM], vol.Length(min=1, max=MAX_ITEMS))
TIMEOUT = vol.Any(0, vol.All(vol.Coerce(int), vol.Range(min=10, max=86400)))

SCHEMAS = {
    "show_text": vol.Schema(
        {
            vol.Required("text"): vol.All(str, vol.Length(min=1, max=MAX_TEXT)),
            vol.Optional("title"): SHORT,
            vol.Optional("timeout_seconds"): TIMEOUT,
        }
    ),
    "show_recipe": vol.Schema(
        {
            vol.Required("title"): SHORT,
            vol.Required("ingredients"): ITEMS,
            vol.Required("steps"): ITEMS,
            vol.Optional("cooking_time_minutes"): vol.All(vol.Coerce(int), vol.Range(min=1, max=1440)),
            vol.Optional("timeout_seconds"): TIMEOUT,
        }
    ),
    "show_list": vol.Schema(
        {vol.Required("title"): SHORT, vol.Required("items"): ITEMS, vol.Optional("timeout_seconds"): TIMEOUT}
    ),
    "show_timer": vol.Schema(
        {
            vol.Required("name"): SHORT,
            vol.Required("duration_seconds"): vol.All(vol.Coerce(int), vol.Range(min=1, max=86400)),
        }
    ),
    "clear_display": vol.Schema({}),
}

DESCRIPTIONS = {
    "show_text": "Show concise plain text readable from a distance.",
    "show_recipe": "Show a concise recipe with ingredients and ordered steps.",
    "show_list": "Show a concise list readable from a distance.",
    "show_timer": "Start and display a Home Assistant timer.",
    "clear_display": "Return the main display view to idle; does not cancel a timer.",
}


class DisplayTool(llm.Tool):
    """Dispatch one strictly validated command to the shared runtime."""

    def __init__(self, runtime: KitchenDisplayRuntime, name: str) -> None:
        self.runtime = runtime
        self.name = name
        self.description = DESCRIPTIONS[name]
        self.parameters = SCHEMAS[name]

    async def async_call(self, hass, tool_input: llm.ToolInput, llm_context: llm.LLMContext) -> Any:
        return await getattr(self.runtime, self.name)(**tool_input.tool_args)


class KitchenDisplayAPI(llm.API):
    """Dedicated display API for conversation agents."""

    def __init__(self, hass, runtime: KitchenDisplayRuntime) -> None:
        super().__init__(hass=hass, id="kitchen_display", name="Kitchen Display")
        self.runtime = runtime

    async def async_get_api_instance(self, llm_context: llm.LLMContext) -> llm.APIInstance:
        prompt = (
            "Use the display for recipes, lists, multi-step instructions, timers, "
            "and information worth leaving visible. Always obey an explicit request "
            "to show something and accompany visual output with a short conversational "
            "response. Do not use it for greetings, jokes, acknowledgements, or short "
            "factual answers. Keep content concise and readable from a distance. Use "
            "only the supported structured tools; never send HTML or other markup. "
            "Följ samma policy på svenska: visa recept, listor, instruktioner, timers "
            "och information som bör stå kvar; svara också kort muntligt."
        )
        return llm.APIInstance(
            api=self,
            api_prompt=prompt,
            llm_context=llm_context,
            tools=[DisplayTool(self.runtime, name) for name in SCHEMAS],
        )
