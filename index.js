const express = require('express');
const app = express();
const statusRoute = require('./routes/status');

app.use('/status', statusRoute);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server live on port ${PORT}`));