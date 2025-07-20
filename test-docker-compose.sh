#!/bin/bash
# Docker Compose Test Script for ARCANOS
# Tests the docker-compose.yml configuration

set -e

echo "🐳 Testing ARCANOS Docker Compose Configuration"
echo "================================================"

# Check if Docker and Docker Compose are available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed or not available"
    exit 1
fi

if ! docker compose version &> /dev/null; then
    echo "❌ Docker Compose is not available"
    exit 1
fi

echo "✅ Docker and Docker Compose are available"

# Validate docker-compose.yml syntax
echo "🔍 Validating docker-compose.yml syntax..."
if docker compose config > /dev/null; then
    echo "✅ docker-compose.yml syntax is valid"
else
    echo "❌ docker-compose.yml syntax is invalid"
    exit 1
fi

# Build arcanos-core service
echo "🔨 Building arcanos-core service..."
if docker compose build arcanos-core; then
    echo "✅ arcanos-core build successful"
else
    echo "❌ arcanos-core build failed"
    exit 1
fi

# Start arcanos-core service
echo "🚀 Starting arcanos-core service..."
if docker compose up -d arcanos-core; then
    echo "✅ arcanos-core service started"
else
    echo "❌ Failed to start arcanos-core service"
    exit 1
fi

# Wait for service to be ready
echo "⏳ Waiting for service to be ready..."
sleep 10

# Check if service is running
if docker compose ps arcanos-core | grep -q "Up"; then
    echo "✅ arcanos-core service is running"
else
    echo "❌ arcanos-core service is not running"
    docker compose logs arcanos-core
    docker compose down
    exit 1
fi

# Test health endpoint
echo "🏥 Testing health endpoint..."
if curl -f http://localhost:8080/health > /dev/null 2>&1; then
    echo "✅ Health endpoint is responding"
else
    echo "❌ Health endpoint is not responding"
    docker compose logs arcanos-core
    docker compose down
    exit 1
fi

# Clean up
echo "🧹 Cleaning up..."
docker compose down

echo ""
echo "🎉 All tests passed! Docker Compose configuration is working correctly."
echo ""
echo "📝 Notes:"
echo "   - arcanos-core service builds and runs successfully"
echo "   - Network configuration is correct"
echo "   - Health endpoint is accessible"
echo "   - backstage-booker service configuration is valid (image needs to be provided separately)"