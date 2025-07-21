#!/bin/bash

# Arcanos Development Setup Script
echo "🔧 Setting up Arcanos development environment..."

# Check if .env exists, if not create from example
if [ ! -f .env ]; then
    echo "📋 Creating .env file from .env.example..."
    cp .env.example .env
    echo "✅ .env file created. You can edit it to customize your configuration."
else
    echo "✅ .env file already exists."
fi

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker and try again."
    exit 1
fi

# Start PostgreSQL database using Docker Compose
echo "🐘 Starting PostgreSQL database..."
docker-compose up -d postgres

# Wait for database to be ready
echo "⏳ Waiting for database to be ready..."
timeout=30
counter=0
while ! docker-compose exec -T postgres pg_isready -U arcanos -d arcanos > /dev/null 2>&1; do
    counter=$((counter + 1))
    if [ $counter -ge $timeout ]; then
        echo "❌ Database failed to start within $timeout seconds"
        exit 1
    fi
    sleep 1
    echo -n "."
done
echo ""

echo "✅ PostgreSQL database is ready!"
echo "📊 Database connection: postgresql://arcanos:arcanos@localhost:5432/arcanos"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
fi

# Build the project
echo "🔨 Building the project..."
npm run build

echo ""
echo "🎉 Development environment setup complete!"
echo ""
echo "To start the application:"
echo "  npm run dev    # Development mode with hot reload"
echo "  npm start      # Production mode"
echo ""
echo "To stop the database:"
echo "  docker-compose down"
echo ""
echo "Database will be available at:"
echo "  postgresql://arcanos:arcanos@localhost:5432/arcanos"