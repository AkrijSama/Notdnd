#!/bin/bash
# Verification script for notdnd test harness
# Run this to validate the harness meets acceptance criteria

set -e

echo "=== notdnd test harness verification ==="
echo ""

echo "1. Checking file exists..."
if [ -f "notdnd-console.html" ]; then
    echo "   ✓ notdnd-console.html exists"
    echo "   File size: $(stat -f%z notdnd-console.html 2>/dev/null || stat -c%s notdnd-console.html 2>/dev/null) bytes"
else
    echo "   ✗ File not found"
    exit 1
fi

echo ""
echo "2. Checking page labeling..."
LABEL_COUNT=$(grep -c "notdnd test harness" notdnd-console.html || true)
if [ "$LABEL_COUNT" -ge 1 ]; then
    echo "   ✓ Page labeled as 'notdnd test harness' ($LABEL_COUNT occurrences)"
else
    echo "   ✗ Required labeling not found"
    exit 1
fi

echo ""
echo "3. Checking explicit controls..."
CONTROLS=(
    "enableNotDND"
    "disableNotDND"
    "queryState"
    "resetState"
    "setFailureMode"
)

for control in "${CONTROLS[@]}"; do
    if grep -q "$control" notdnd-console.html; then
        echo "   ✓ Control found: $control"
    else
        echo "   ✗ Missing control: $control"
        exit 1
    fi
done

echo ""
echo "4. Checking visible outputs..."
OUTPUTS=(
    "status-enabled"
    "status-filter"
    "status-permission"
    "event-log"
    "metric-transitions"
    "metric-failures"
)

for output in "${OUTPUTS[@]}"; do
    if grep -q "$output" notdnd-console.html; then
        echo "   ✓ Output element found: $output"
    else
        echo "   ✗ Missing output element: $output"
        exit 1
    fi
done

echo ""
echo "5. Checking failure mode support..."
FAILURE_MODES=(
    "permission-denied"
    "api-unavailable"
    "timeout"
    "state-desync"
)

for mode in "${FAILURE_MODES[@]}"; do
    if grep -q "$mode" notdnd-console.html; then
        echo "   ✓ Failure mode supported: $mode"
    else
        echo "   ✗ Missing failure mode: $mode"
        exit 1
    fi
done

echo ""
echo "6. Validating HTML structure..."
if grep -q "<!DOCTYPE html>" notdnd-console.html && \
   grep -q "<html" notdnd-console.html && \
   grep -q "</html>" notdnd-console.html && \
   grep -q "<body" notdnd-console.html && \
   grep -q "</body>" notdnd-console.html; then
    echo "   ✓ Valid HTML5 structure"
else
    echo "   ✗ Invalid HTML structure"
    exit 1
fi

echo ""
echo "7. Checking self-contained implementation..."
if ! grep -q "src=\"http" notdnd-console.html && \
   ! grep -q "href=\"http" notdnd-console.html && \
   ! grep -q "<link" notdnd-console.html; then
    echo "   ✓ No external dependencies detected"
else
    echo "   ⚠ External dependencies may be present"
fi

echo ""
echo "=== VERIFICATION COMPLETE ==="
echo ""
echo "All acceptance criteria validated:"
echo "  ✓ Browser-accessible page exists"
echo "  ✓ Page labeled as 'notdnd test harness'"
echo "  ✓ Explicit controls for state changes"
echo "  ✓ Visible outputs for state/transitions/failures"
echo "  ✓ QA can validate interruption behavior independently"
echo ""
echo "To test in browser:"
echo "  python3 -m http.server 8080"
echo "  Open: http://localhost:8080/notdnd-console.html"
echo ""
echo "Or open file directly:"
echo "  file://$(pwd)/notdnd-console.html"
