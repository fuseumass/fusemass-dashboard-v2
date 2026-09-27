#!/bin/bash

# Admin credentials come from the environment — never commit real ones.
# Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... ./list-meals.sh
: "${ADMIN_EMAIL:?Set ADMIN_EMAIL}"
: "${ADMIN_PASSWORD:?Set ADMIN_PASSWORD}"

# Login and get JWT token
echo "Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$ADMIN_EMAIL\", \"password\": \"$ADMIN_PASSWORD\"}")

echo "Login response: $LOGIN_RESPONSE"

# Extract token from response
TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "Failed to get token. Check your password."
  exit 1
fi

echo "Got token: $TOKEN"
echo ""
echo "Listing meals..."

# List meals
curl -X GET http://localhost:4000/api/admin/meals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN"
