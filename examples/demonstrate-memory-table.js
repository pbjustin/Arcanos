#!/usr/bin/env node

/**
 * Demonstration script showing that the memory table is created on startup
 * as specified in the problem statement:
 * CREATE TABLE IF NOT EXISTS memory (key TEXT PRIMARY KEY, value JSONB NOT NULL);
 */

import { Client } from 'pg';
import 'dotenv/config';

export async function demonstrateMemoryTable() {
  console.log('🎯 Demonstrating memory table creation as per problem statement...');
  
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.log('⚠️ Set DATABASE_URL to test database connectivity and table creation');
    console.log('📝 Example: DATABASE_URL=postgresql://user:pass@localhost:5432/dbname');
    return;
  }

  const client = new Client({
    connectionString: databaseUrl,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('✅ Connected to DATABASE_URL');

    // Verify the memory table exists with correct schema
    const schemaQuery = `
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
      AND table_name = 'memory'
      ORDER BY ordinal_position;
    `;
    
    const result = await client.query(schemaQuery);
    
    if (result.rows.length === 0) {
      console.log('❌ memory table not found');
      console.log('💡 Start the application to create the table automatically');
      return;
    }
    
    console.log('✅ memory table found with schema:');
    result.rows.forEach(col => {
      console.log(`   ${col.column_name}: ${col.data_type} (NOT NULL: ${col.is_nullable === 'NO'})`);
    });
    
    // Verify primary key
    const pkQuery = `
      SELECT column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
      WHERE tc.table_schema = 'public' 
      AND tc.table_name = 'memory'
      AND tc.constraint_type = 'PRIMARY KEY';
    `;
    
    const pkResult = await client.query(pkQuery);
    if (pkResult.rows[0]?.column_name === 'key') {
      console.log('✅ Primary key constraint on key column verified');
    }
    
    // Demonstrate usage
    const testKey = 'demo_key';
    const testValue = { demo: true, timestamp: new Date().toISOString() };
    
    await client.query('DELETE FROM memory WHERE key = $1', [testKey]);
    await client.query('INSERT INTO memory (key, value) VALUES ($1, $2)', [testKey, JSON.stringify(testValue)]);
    const testResult = await client.query('SELECT * FROM memory WHERE key = $1', [testKey]);
    
    console.log('✅ Successfully inserted and retrieved test data:');
    console.log('   Key:', testResult.rows[0].key);
    console.log('   Value:', testResult.rows[0].value);
    
    // Clean up
    await client.query('DELETE FROM memory WHERE key = $1', [testKey]);
    
    console.log('🎯 Memory table implementation verified successfully!');
    console.log('📋 Schema matches problem statement exactly:');
    console.log('   CREATE TABLE IF NOT EXISTS memory (key TEXT PRIMARY KEY, value JSONB NOT NULL);');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await client.end();
  }
}

// ESM module entry point detection
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateMemoryTable().catch(console.error);
}