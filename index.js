const express = require('express');
const path = require('path');
const app = express();
const statusRoute = require('./routes/status');
const memoryRoute = require('./routes/memory');
const testMemoryRoute = require('./routes/testMemory');

// Initialize database connection and memory table
require('./services/database-connection');

// Serve static dashboard assets
app.use(express.static(path.join(__dirname, 'public')));

app.use('/status', statusRoute);
app.use('/memory', memoryRoute);
app.use('/api', testMemoryRoute);

// Prisma example connection (as specified in problem statement)
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function examplePrismaUsage() {
  try {
    const users = await prisma.user.findMany();
    console.log('Users from Prisma:', users);
  } catch (error) {
    console.log('Prisma connection info: Database connection will be established when DATABASE_URL points to active PostgreSQL instance');
  }
}

// Run Prisma example on startup
examplePrismaUsage();

// Global error catcher
const { logError } = require('./utils/logger');
app.use((err, req, res, next) => {
  logError(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Root dashboard route
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));