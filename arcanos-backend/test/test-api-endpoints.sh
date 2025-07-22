#!/bin/bash
curl -s -X POST http://localhost:3000/arcanos \
  -H "Content-Type: application/json" \
  -d '{"query":"status"}'
