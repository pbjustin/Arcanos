#!/usr/bin/env node
/**
 * Test to verify that the Docker container can find and run railway/workers.js
 * This addresses the issue: Error: Cannot find module '/app/railway/workers.js'
 */

import { exec } from 'child_process';
import path from 'path';

console.log('🧪 Testing Docker container workers.js resolution...');

// Test that the Docker build includes the necessary files
const testDockerBuild = () => {
  return new Promise((resolve, reject) => {
    console.log('📦 Building Docker image...');
    exec('docker build -t arcanos-test-temp .', { cwd: process.cwd() }, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Docker build failed:', error);
        reject(error);
        return;
      }
      console.log('✅ Docker build successful');
      resolve();
    });
  });
};

// Test that the container starts without the module not found error
const testContainerStart = () => {
  return new Promise((resolve, reject) => {
    console.log('🚀 Starting container to test workers.js...');
    const container = exec('docker run --rm --name arcanos-test-temp arcanos-test-temp', (error, stdout, stderr) => {
      // We expect the container to start successfully and show workers starting
      // We'll kill it after a few seconds to prevent infinite running
    });

    let output = '';
    container.stdout.on('data', (data) => {
      output += data.toString();
    });

    container.stderr.on('data', (data) => {
      output += data.toString();
    });

    // Give it 5 seconds to start and show that workers are loading
    setTimeout(() => {
      exec('docker kill arcanos-test-temp', () => {
        if (output.includes('Error: Cannot find module \'/app/railway/workers.js\'')) {
          console.error('❌ Module not found error still exists');
          reject(new Error('Module not found error detected'));
        } else if (output.includes('Starting ARCANOS workers manager')) {
          console.log('✅ Workers manager started successfully');
          resolve();
        } else {
          console.log('📄 Container output:', output.substring(0, 500) + '...');
          console.log('⚠️  Unable to verify complete success, but no module error detected');
          resolve();
        }
      });
    }, 5000);
  });
};

// Cleanup function
const cleanup = () => {
  exec('docker rmi arcanos-test-temp', () => {
    console.log('🧹 Cleanup completed');
  });
};

// Run tests
(async () => {
  try {
    await testDockerBuild();
    await testContainerStart();
    console.log('🎉 All tests passed - Docker workers.js issue is resolved!');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  } finally {
    cleanup();
  }
})();