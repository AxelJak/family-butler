# Physical acceptance checklist

Automated tests cover the protocol, validation, persistence, lifecycle, and SSE
transport. Complete this checklist on the real Pi, Home Assistant instance, and
first-generation iPad Air before treating V1 as deployed.

## Pi and network

- [ ] `http://kitchen-display.local/api/health` responds from the home LAN.
- [ ] The API is unreachable from outside the LAN.
- [ ] An unauthorized POST returns 401 and does not change the display.
- [ ] Invalid and extra payload fields return 400 and do not change state.
- [ ] The service returns after a Pi reboot and after a forced process restart.
- [ ] Persistent recipe/list content survives a service restart.
- [ ] Temporary content that expires while offline is not restored.

## iPad

Before continuous use, inspect the old iPad and stop if its battery is swollen
or the enclosure is separating.

1. Join the trusted Wi-Fi and open `http://kitchen-display.local` in Safari.
2. Add the page to the Home Screen.
3. Set Auto-Lock to Never while it is used as the display.
4. Enable Guided Access if the display should remain locked to the web app.
5. Keep it landscape, use a safe charger, and choose a comfortable brightness.

Verify:

- [ ] Idle clock/date are correct, legible, and shown in Swedish.
- [ ] Text is readable from the intended viewing distance.
- [ ] Recipe columns work in landscape and manually scroll when long.
- [ ] Lists remain legible and manually scroll when long.
- [ ] Portrait fallback is usable.
- [ ] An active timer banner does not hide important content.
- [ ] Focused and finished timer views fit without clipping.
- [ ] Disconnecting Wi-Fi keeps the last useful view and shows a small warning.
- [ ] Reconnecting updates the screen without a manual reload.
- [ ] The page remains stable during an overnight run.

## Home Assistant and voice

- [ ] All five Kitchen Display actions work from Developer tools.
- [ ] `clear_display` does not cancel an active HA timer.
- [ ] Pausing, resuming, restarting, cancelling, and finishing the selected HA
      timer are reflected on the display.
- [ ] The OpenRouter agent has only Assist and Kitchen Display APIs selected.
- [ ] A Swedish light command controls the intended exposed light.
- [ ] Short answers do not unnecessarily use the display.
- [ ] Explicit show requests always use the display.
- [ ] Recipe requests produce structured ingredients and steps.
- [ ] Voice and text pass the same model acceptance prompts.
- [ ] ElevenLabs quota/network failure leaves text input usable.

Record any readability or model-tool failures before UI or prompt tuning. Test
one change at a time against this same checklist.
