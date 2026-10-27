# Physical acceptance checklist

Automated tests cannot establish Safari 12 behavior or physical readability.
Run these checks on the Pi and actual iPad before relying on the appliance.

- [ ] Boot the Pi and verify systemd starts the service without a logged-in user.
- [ ] Open the display on the iPad and configure Home Screen, Auto-Lock Never, and Guided Access.
- [ ] Connect your assistant's HTTP MCP client using its securely stored bearer header.
- [ ] Discover tools and ask “Visa en inköpslista med mjölk och pasta.”
- [ ] Verify `get_display_state` reports a visible acknowledgement and actual page count.
- [ ] Ask to mark milk as bought; verify only the correct stable item ID changes.
- [ ] Display long text/list/recipe content. Navigate every page through the assistant without touching or scrolling. Verify every part of the content is reachable and readable.
- [ ] Rotate the iPad and verify pages are recalculated and accurately acknowledged.
- [ ] Display a recipe and request the next cooking step, then restore the overview.
- [ ] Display temporary text over a recipe; verify expiry restores its prior page/step.
- [ ] Start two named timers, pause/resume one, and verify the other keeps running.
- [ ] Retry the exact start_timer operation ID and arguments; verify no duplicate or restarted countdown.
- [ ] Disconnect the assistant and verify timers finish with a visual alert for 60 seconds and restore prior content.
- [ ] Restart the Pi during running and paused timers; verify remaining duration and IDs survive.
- [ ] Restart after a timer's deadline and alert window; verify finished state without a new stale alert.
- [ ] Cancel a finished timer and verify its banner disappears without clearing other timers/content.
- [ ] Hide Safari; verify it is not treated as a visible acknowledgement. Return and verify fresh reporting.
- [ ] Interrupt Wi-Fi; verify last content remains and a connection warning appears. Reconnect and verify current content returns without stale reporting credentials.
- [ ] Reject missing/wrong control tokens, foreign browser origins, invalid tool fields, and oversized requests.
- [ ] Verify the browser holds no control token and has no touch controls.
- [ ] If upgrading V1, verify automatic state conversion and the preserved V1 backup before proceeding.

Completion alerts are visual; audible alarms are not guaranteed. Assistant
hosts supply their own conversation, voice, and external capabilities.
