# notdnd test harness

Browser-based test console for validating notdnd interruption-state behavior.

## Usage

Open `notdnd-console.html` in any modern browser. No build step or dependencies required.

```bash
# Option 1: Direct file open
open notdnd-console.html

# Option 2: Via HTTP server
python3 -m http.server 8080
# Navigate to http://localhost:8080/notdnd-console.html
```

## Interface sections

### API availability
Shows which browser APIs are available for testing:
- Notification API (core requirement for notdnd)
- Permissions API
- Focus detection
- Visibility API
- Page Visibility

### State controls
- **Enable notdnd**: Request notification permission and enable interruption filtering
- **Disable notdnd**: Disable interruption filtering
- **Query current state**: Read and log all current state values
- **Reset state**: Clear all state and metrics

### Failure mode injection
Dropdown selector to inject specific failure conditions:
- None (normal operation)
- Permission denied
- API unavailable
- Timeout
- State desynchronization

### Current state
Real-time display of:
- notdnd enabled status (TRUE/FALSE)
- Interruption filter setting
- Permission state
- Last state change timestamp
- Active failure mode
- Metrics: transitions, failures, API calls

### Transition history & failure log
Timestamped event log showing:
- State transitions (cyan)
- Information events (green)
- Warnings (yellow)
- Errors (red)

Controls:
- **Clear log**: Remove all entries
- **Export log**: Download log as timestamped .txt file

## Test scenarios

### Basic state transitions
1. Click "Enable notdnd"
2. Observe permission request (if first run)
3. Verify "notdnd enabled" shows TRUE in Current state
4. Verify transition logged in event log
5. Click "Disable notdnd"
6. Verify "notdnd enabled" shows FALSE

### Permission handling
1. Reset state
2. Revoke notification permission in browser settings
3. Click "Enable notdnd"
4. Observe permission request
5. Deny permission
6. Verify error logged showing permission denial

### Failure mode validation
1. Select "Permission denied" from failure mode dropdown
2. Click "Enable notdnd"
3. Verify "FAILURE INJECTED: Permission denied" appears in log
4. Verify failure metric increments
5. Test other failure modes similarly

### API availability
1. Check API availability section at page load
2. If any API shows UNAVAILABLE, corresponding warnings appear in log
3. Verify harness still functional with degraded API support

### Event monitoring
1. Open harness in one tab
2. Switch to another tab
3. Return to harness tab
4. Verify visibility and focus events logged

## Validation checklist

- [ ] Page loads without errors in browser console
- [ ] All five API availability checks display status
- [ ] Four state control buttons are clickable
- [ ] Failure mode selector has five options
- [ ] Current state section updates when controls clicked
- [ ] Event log displays timestamped entries
- [ ] Log entries color-coded by type
- [ ] Metrics increment correctly
- [ ] Export log downloads file
- [ ] Clear log empties event history
- [ ] State transitions visible in real-time
- [ ] Failure modes inject errors as expected
- [ ] Permission flow works end-to-end

## File structure

```
notdnd-console.html    Self-contained harness (HTML + CSS + JS)
HARNESS_README.md      This file
```

No external dependencies. No build process. No configuration files.
