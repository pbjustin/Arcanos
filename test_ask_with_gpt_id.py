#!/usr/bin/env python3
"""Test /api/ask with x-gpt-id header to mimic custom GPT (ARCANOS v2)."""
import requests

url = "https://arcanos-production.up.railway.app/api/ask"
headers = {
    "Content-Type": "application/json",
    "User-Agent": "ARCANOS-Test/1.0",
    "x-gpt-id": "ARCANOS v2",  # Match diagnostic "Invoker: ARCANOS v2"
}
body = {"message": "Hello! What can you help me with?"}

try:
    r = requests.post(url, json=body, headers=headers, timeout=30)
    print(f"Status: {r.status_code}")
    print(f"Response: {r.text[:500]}")
except Exception as e:
    print(f"Error: {e}")
