// Test to reproduce the DATABASE_URL warning
const dotenv = require('dotenv');

// Load environment variables first
dotenv.config();

// Temporarily clear DATABASE_URL to reproduce the warning
delete process.env.DATABASE_URL;

// Import the compiled database service
try {
  const { DatabaseService } = require('./dist/services/database');
  
  console.log('Creating DatabaseService instance...');
  const dbService = new DatabaseService();
  
  console.log('Test completed');
} catch (error) {
  console.error('Error:', error.message);
}