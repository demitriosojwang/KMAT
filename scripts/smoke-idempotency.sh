#!/usr/bin/env bash
# Idempotency smoke test for /api/passengers after the ponytail-audit split.
# Boots dev server, runs the test, kills server.
set -e

cd /home/z/my-project

pkill -f "next dev" 2>/dev/null || true
sleep 2

# Start dev server detached
bunx next dev -p 3000 > /tmp/dev.log 2>&1 &
DEV_PID=$!
disown $DEV_PID 2>/dev/null || true
sleep 6

# Confirm alive
if ! ps -p $DEV_PID > /dev/null; then
  echo "Dev server died on startup"
  cat /tmp/dev.log
  exit 1
fi
echo "Dev server alive (PID $DEV_PID)"

# Fetch owner ID
OWNER_DATA=$(curl -s http://localhost:3000/api/owners)
OWNER_ID=$(echo "$OWNER_DATA" | python3 -c "import json,sys; d=json.load(sys.stdin); print([o for o in d['owners'] if o['region']=='Mombasa'][0]['id'])")
echo "Owner: $OWNER_ID"

# Fetch bus + free seat
BUS_DATA=$(curl -s -H "x-owner-id: $OWNER_ID" http://localhost:3000/api/bus)
BUS_ID=$(echo "$BUS_DATA" | python3 -c "import json,sys; print(json.load(sys.stdin)['bus']['id'])")
FREE_SEAT=$(echo "$BUS_DATA" | python3 -c "import json,sys; d=json.load(sys.stdin); free=[s for s in d['bus']['seats'] if not s['isOccupied']]; print(free[0]['number'] if free else None)")
echo "Bus: $BUS_ID | Free seat: $FREE_SEAT"

# POST 1
CLIENT_ID="verify-$(date +%s)-$RANDOM"
echo ""
echo "=== POST 1 (clientId=$CLIENT_ID) ==="
RESP1=$(curl -s -X POST -H "Content-Type: application/json" -H "x-owner-id: $OWNER_ID" http://localhost:3000/api/passengers -d "{\"name\":\"Verify\",\"seatNumber\":$FREE_SEAT,\"boardingStop\":\"Likoni\",\"alightingStop\":\"Mtwapa\",\"alightingStopOrder\":3,\"fare\":150,\"paymentMethod\":\"mpesa\",\"busId\":\"$BUS_ID\",\"clientId\":\"$CLIENT_ID\"}")
echo "$RESP1" | python3 -m json.tool

# POST 2 (same clientId)
echo ""
echo "=== POST 2 (same clientId — should dedupe) ==="
RESP2=$(curl -s -X POST -H "Content-Type: application/json" -H "x-owner-id: $OWNER_ID" http://localhost:3000/api/passengers -d "{\"name\":\"Verify\",\"seatNumber\":$FREE_SEAT,\"boardingStop\":\"Likoni\",\"alightingStop\":\"Mtwapa\",\"alightingStopOrder\":3,\"fare\":150,\"paymentMethod\":\"mpesa\",\"busId\":\"$BUS_ID\",\"clientId\":\"$CLIENT_ID\"}")
echo "$RESP2" | python3 -m json.tool

# Verify
PAX1=$(echo "$RESP1" | python3 -c "import json,sys; print(json.load(sys.stdin).get('passenger',{}).get('id','NONE'))")
PAX2=$(echo "$RESP2" | python3 -c "import json,sys; print(json.load(sys.stdin).get('passenger',{}).get('id','NONE'))")
DEDUPED=$(echo "$RESP2" | python3 -c "import json,sys; print(json.load(sys.stdin).get('deduped',False))")
echo ""
echo "PAX1=$PAX1 | PAX2=$PAX2 | deduped=$DEDUPED"
if [ "$PAX1" = "$PAX2" ] && [ "$PAX1" != "NONE" ] && [ "$DEDUPED" = "True" ]; then
  echo "✓ IDEMPOTENT — same passenger returned, deduped=True"
  RESULT=0
else
  echo "✗ FAIL"
  RESULT=1
fi

# Kill dev server
kill $DEV_PID 2>/dev/null || true
pkill -f "next dev" 2>/dev/null || true

exit $RESULT
