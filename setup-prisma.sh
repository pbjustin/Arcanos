#!/bin/bash

# setup-prisma.sh
# Setup script for Node.js project using Prisma

set -euo pipefail

# 1. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 2. Generate Prisma client
echo "⚙️ Generating Prisma client..."
npx prisma generate

# 3. Push Prisma schema to the database
echo "🚀 Pushing Prisma schema to database..."
npx prisma db push

# 4. If migrations directory exists, deploy migrations
if [ -d "prisma/migrations" ]; then
  echo "📂 Applying existing migrations..."
  npx prisma migrate deploy
else
  echo "ℹ️ No migrations directory found. Skipping migrate deploy."
fi

echo "✅ Setup complete"
