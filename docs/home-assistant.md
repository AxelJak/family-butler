# Home Assistant setup

Target the latest stable Home Assistant OS release. This setup needs no Home
Assistant Cloud subscription and no separate Hermes or OpenClaw process.

## 1. Create the timer helper

In **Settings → Devices & services → Helpers**, create one Timer helper named
`Kitchen Display`. Confirm its entity ID (the examples assume
`timer.kitchen_display`). V1 intentionally supports one timer; starting a new
one replaces the old one.

## 2. Install Kitchen Display

Until this repository is published as a HACS default repository, choose one:

- **Manual:** copy `custom_components/kitchen_display` into
  `/config/custom_components/kitchen_display` using the Studio Code Server,
  Terminal, or Samba add-on, then restart Home Assistant.
- **HACS custom repository:** add
  `https://github.com/axeljak/family-butler` as an Integration repository,
  install Kitchen Display, and restart Home Assistant.

Go to **Settings → Devices & services → Add integration → Kitchen Display**.
Enter:

- URL: `http://kitchen-display.local`
- bearer token: the value generated on the Pi
- timer helper: `timer.kitchen_display`

The setup check validates the connection and token without changing the
screen. The integration then provides an availability diagnostic, these Home
Assistant actions, and a distinct `Kitchen Display` LLM API:

- `kitchen_display.show_text`
- `kitchen_display.show_recipe`
- `kitchen_display.show_list`
- `kitchen_display.show_timer`
- `kitchen_display.clear_display`

Test an action in **Developer tools → Actions**:

```yaml
action: kitchen_display.show_text
data:
  title: Test
  text: Köksdisplayen är ansluten.
  timeout_seconds: 30
```

Then test a persistent recipe:

```yaml
action: kitchen_display.show_recipe
data:
  title: Enkel pasta
  ingredients:
    - Pasta
    - Parmesan
  steps:
    - Koka pastan.
    - Riv över parmesan.
```

## 3. Configure OpenRouter

1. Create an OpenRouter API key with a conservative spending limit.
2. Add the official **OpenRouter** integration under **Settings → Devices &
   services**.
3. On its integration entry, add a conversation agent.
4. Start with model ID `z-ai/glm-5.3-flash`. It supports tool calling and is
   inexpensive, but it is a new model: the acceptance tests below decide
   whether it is suitable, not its benchmark score.
5. In the agent's multi-select **LLM APIs** setting, select both **Assist** and
   **Kitchen Display**. If Kitchen Display is absent, reload or restart Home
   Assistant after setting up the custom integration.
6. Leave web search off for V1.

Suggested agent prompt:

```text
Du är Kitchen Butler, en kortfattad och hjälpsam assistent för hemmet.
Svara på svenska om användaren inte använder ett annat språk.
Använd Home Assistants verktyg för att läsa och styra exponerade enheter.
Påstå aldrig att en åtgärd lyckades om verktyget misslyckades.
Du har också en fysisk köksdisplay. Följ instruktionerna från Kitchen Display-
verktygen och använd displayen när information blir tydligare visuellt eller
bör finnas kvar efter samtalet. Svara samtidigt kort i konversationen.
```

Only expose the entities the assistant should control under **Settings → Voice
assistants → Expose**. Give lights and rooms natural Swedish aliases. The
built-in Assist API cannot perform administrative Home Assistant tasks, but it
can read and control exposed entities such as lights.

## 4. Configure ElevenLabs and Kitchen Butler

Your existing ElevenLabs subscription can be used. Create an API key with:

- Text to Speech
- Speech to Text
- Voices (read only)
- Models (read only)

Add the official **ElevenLabs** integration. Then go to **Settings → Voice
assistants → Add assistant** and configure:

- name: `Kitchen Butler`
- language: Swedish
- conversation agent: the OpenRouter agent above
- speech-to-text: ElevenLabs
- text-to-speech: ElevenLabs with a Swedish-capable voice/model
- **Prefer handling commands locally:** enabled

That preference is useful but does not guarantee every light command bypasses
the LLM when a control-capable conversation agent is selected. Light control
still works through the selected Assist API; include it in acceptance testing.
Text input in Home Assistant remains the fallback if cloud speech or quota is
unavailable.

## 5. Acceptance prompts for the model

Run each in Swedish using text first, then the Companion App microphone:

1. `Tänd kökslampan.` — the exposed light turns on; no display card.
2. `Vad är två plus två?` — short spoken/text answer; no display card.
3. `Visa att Systembolaget stänger klockan 19 i två minuter.` — text card
   appears and later returns to idle.
4. `Visa en inköpslista med mjölk, pasta och parmesan.` — persistent list.
5. `Visa ett enkelt recept på pasta med parmesan.` — structured recipe with
   ingredients and ordered steps, plus a short conversational answer.
6. `Starta en pastatimer på 30 sekunder.` — HA timer starts, display counts
   down, completion takes over for 60 seconds, then prior content returns.
7. Ask it to put HTML or unsupported widgets on the display — it must either
   use plain text or explain that the view is unsupported.

If GLM 5.3 Flash misses tools, fabricates success, or behaves poorly in Swedish,
switch to another low-cost OpenRouter model that explicitly supports tool
calling and repeat the same suite. Do not compensate for unreliable tool use by
giving the model broader permissions.

## Timer sound

The display provides the visual finished alert. Safari is not trusted for
background audio. When a suitable kitchen media player exists, add a Home
Assistant automation triggered by `timer.finished` for
`timer.kitchen_display`, and call `tts.speak` using the ElevenLabs TTS entity.
Until then, the visual alert is the V1 completion signal.
