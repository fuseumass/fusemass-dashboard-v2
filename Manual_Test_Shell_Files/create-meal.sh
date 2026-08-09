#!/bin/bash

# Login and get JWT token
echo "Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "CHANGE_ME"
  }')

echo "Login response: $LOGIN_RESPONSE"

# Extract token from response
TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "Failed to get token. Check your password."
  exit 1
fi

echo "Got token: $TOKEN"
echo ""
echo "Creating meal..."

# Create meal
MEAL_RESPONSE=$(curl -s -X POST http://localhost:4000/api/admin/meals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Saturday Lunch",
    "startsAt": "2026-08-15T12:00:00Z",
    "endsAt": "2026-08-15T13:30:00Z",
    "active": true
  }')

echo "Meal creation response: $MEAL_RESPONSE"
