"""Tests for strict tools and shared dispatch."""

from unittest.mock import AsyncMock, MagicMock

import pytest
import voluptuous as vol
from homeassistant.helpers.llm import ToolInput

from custom_components.kitchen_display.llm import SCHEMAS, DisplayTool, KitchenDisplayAPI


def test_schema_limits() -> None:
    assert SCHEMAS["show_text"]({"text": "ok", "timeout_seconds": 0})
    with pytest.raises(vol.Invalid):
        SCHEMAS["show_text"]({"text": "ok", "timeout_seconds": 5})
    with pytest.raises(vol.Invalid):
        SCHEMAS["show_list"]({"title": "x", "items": ["x"] * 51})


@pytest.mark.asyncio
async def test_tool_dispatches_shared_runtime() -> None:
    runtime = AsyncMock()
    runtime.show_list.return_value = {"ok": True}
    tool = DisplayTool(runtime, "show_list")
    result = await tool.async_call(
        None, ToolInput(tool_name="show_list", tool_args={"title": "T", "items": ["a"]}), None
    )
    assert result == {"ok": True}
    runtime.show_list.assert_awaited_once_with(title="T", items=["a"])


@pytest.mark.asyncio
async def test_llm_api_exposes_all_display_tools() -> None:
    instance = await KitchenDisplayAPI(MagicMock(), AsyncMock()).async_get_api_instance(MagicMock())

    assert {tool.name for tool in instance.tools} == set(SCHEMAS)
    assert {"show_text", "show_recipe"} <= {tool.name for tool in instance.tools}
