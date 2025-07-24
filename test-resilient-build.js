#!/usr/bin/env node

/**
 * Test script to verify the resilient build process
 * This test validates that the build succeeds even when optional directories are missing
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname);
const OPTIONAL_DIRS = ['workers', 'memory', 'api'];

console.log('🧪 Testing Resilient Build Process');
console.log('=====================================\n');

// Helper function to run build and check result
function runBuildTest(scenario, missingDirs = []) {
    console.log(`\n📋 Testing scenario: ${scenario}`);
    
    const backupPaths = {};
    
    try {
        // Backup and remove directories if needed
        missingDirs.forEach(dir => {
            const dirPath = path.join(PROJECT_ROOT, dir);
            const backupPath = path.join(PROJECT_ROOT, `${dir}_test_backup`);
            
            if (fs.existsSync(dirPath)) {
                fs.renameSync(dirPath, backupPath);
                backupPaths[dir] = backupPath;
                console.log(`   🗂️  Temporarily removed: ${dir}/`);
            }
        });
        
        // Run the build
        console.log('   🔨 Running npm run build...');
        execSync('npm run build', { 
            cwd: PROJECT_ROOT, 
            stdio: 'pipe' 
        });
        
        // Check what was actually built
        const distPath = path.join(PROJECT_ROOT, 'dist');
        if (!fs.existsSync(distPath)) {
            throw new Error('dist directory was not created');
        }
        
        const builtDirs = OPTIONAL_DIRS.filter(dir => 
            fs.existsSync(path.join(distPath, dir))
        );
        
        console.log(`   ✅ Build succeeded!`);
        console.log(`   📦 Built directories: ${builtDirs.length > 0 ? builtDirs.join(', ') : 'none'}`);
        
        return true;
        
    } catch (error) {
        console.error(`   ❌ Build failed: ${error.message}`);
        return false;
        
    } finally {
        // Restore backed up directories
        Object.entries(backupPaths).forEach(([dir, backupPath]) => {
            const dirPath = path.join(PROJECT_ROOT, dir);
            if (fs.existsSync(backupPath)) {
                fs.renameSync(backupPath, dirPath);
                console.log(`   🔄 Restored: ${dir}/`);
            }
        });
    }
}

// Test scenarios
const tests = [
    {
        name: 'All directories present',
        missingDirs: []
    },
    {
        name: 'Missing workers directory',
        missingDirs: ['workers']
    },
    {
        name: 'Missing memory directory', 
        missingDirs: ['memory']
    },
    {
        name: 'Missing api directory',
        missingDirs: ['api']
    },
    {
        name: 'Missing multiple directories (workers, memory)',
        missingDirs: ['workers', 'memory']
    },
    {
        name: 'Missing all optional directories',
        missingDirs: ['workers', 'memory', 'api']
    }
];

// Run all tests
let passed = 0;
let failed = 0;

tests.forEach(test => {
    if (runBuildTest(test.name, test.missingDirs)) {
        passed++;
    } else {
        failed++;
    }
});

// Summary
console.log('\n📊 Test Results');
console.log('================');
console.log(`✅ Passed: ${passed}`);
console.log(`❌ Failed: ${failed}`);
console.log(`📈 Success Rate: ${Math.round((passed / (passed + failed)) * 100)}%`);

if (failed === 0) {
    console.log('\n🎉 All tests passed! The build process is now resilient to missing directories.');
    process.exit(0);
} else {
    console.log('\n⚠️  Some tests failed. The build process needs further fixes.');
    process.exit(1);
}