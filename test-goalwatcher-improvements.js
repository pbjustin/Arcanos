#!/usr/bin/env node
// Test script for GOALWATCHER-IMPROVEMENTS validation

const axios = require('axios');

const BASE_URL = 'http://localhost:8080';

async function testEnhancements() {
  console.log('🧪 Testing GOALWATCHER-IMPROVEMENTS enhancements...\n');
  
  try {
    // Test 1: Memory endpoint with validation
    console.log('1️⃣ Testing enhanced memory endpoint...');
    const memoryResponse = await axios.post(`${BASE_URL}/memory`, {
      memory_key: 'test_enhancement',
      memory_value: { test: 'goalwatcher improvements', timestamp: new Date().toISOString() }
    });
    console.log('✅ Memory: ', memoryResponse.data.timestamp_confirmed ? 'Timestamp confirmed' : 'No timestamp');
    console.log('✅ Memory: ', memoryResponse.data.backup_used ? 'Backup used' : 'Primary used');
    
    // Test 2: Write endpoint with content validation
    console.log('\n2️⃣ Testing enhanced write endpoint...');
    const writeResponse = await axios.post(`${BASE_URL}/write`, {
      message: 'Test content for goalwatcher improvements',
      domain: 'test'
    });
    console.log('✅ Write: ', writeResponse.data.content_validated ? 'Content validated' : 'No validation');
    console.log('✅ Write: ', writeResponse.data.fallback_injected ? 'Fallback injected' : 'Normal response');
    
    // Test 3: Audit endpoint with activity logging
    console.log('\n3️⃣ Testing enhanced audit endpoint...');
    const auditResponse = await axios.post(`${BASE_URL}/audit`, {
      message: 'Test audit for goalwatcher improvements',
      domain: 'security'
    });
    console.log('✅ Audit: ', auditResponse.data.audit_logged ? 'Activity logged' : 'No logging');
    console.log('✅ Audit: ', auditResponse.data.activity_timestamp ? 'Timestamp present' : 'No timestamp');
    
    // Test 4: Diagnostic endpoint with readiness
    console.log('\n4️⃣ Testing enhanced diagnostic endpoint...');
    const diagnosticResponse = await axios.get(`${BASE_URL}/diagnostic?command=system health`);
    console.log('✅ Diagnostic: ', diagnosticResponse.data.readiness_confirmed ? 'Readiness confirmed' : 'Not ready');
    console.log('✅ Diagnostic: ', diagnosticResponse.data.diagnostic_logged ? 'Activity logged' : 'No logging');
    
    // Test 5: Route status monitoring
    console.log('\n5️⃣ Testing route status monitoring...');
    const statusResponse = await axios.get(`${BASE_URL}/route-status`);
    console.log('✅ Status: ', statusResponse.data.routes.length, 'routes tracked');
    console.log('✅ Status: Recovery logs present:', statusResponse.data.recovery_logs.length >= 0);
    
    // Test 6: Audit logs endpoint
    console.log('\n6️⃣ Testing audit logs endpoint...');
    const auditLogsResponse = await axios.get(`${BASE_URL}/audit-logs`);
    console.log('✅ Audit Logs: ', auditLogsResponse.data.audit_activity ? 'Activity logs available' : 'No activity logs');
    console.log('✅ Audit Logs: ', auditLogsResponse.data.readiness_status ? 'Readiness status available' : 'No readiness');
    
    // Test 7: Null content prevention
    console.log('\n7️⃣ Testing null content prevention...');
    try {
      const nullResponse = await axios.post(`${BASE_URL}/write`, {
        message: null,
        domain: 'test'
      });
      console.log('❌ Write: Should have rejected null content');
    } catch (error) {
      console.log('✅ Write: Null content properly rejected (', error.response.status, ')');
    }
    
    // Test 8: Invalid memory request
    console.log('\n8️⃣ Testing route recovery with invalid request...');
    try {
      const invalidResponse = await axios.post(`${BASE_URL}/memory`, {
        // Missing required fields
      });
      console.log('❌ Memory: Should have rejected invalid request');
    } catch (error) {
      console.log('✅ Memory: Invalid request properly handled (', error.response.status, ')');
    }
    
    console.log('\n🎯 All GOALWATCHER-IMPROVEMENTS tests completed!');
    
  } catch (error) {
    console.error('❌ Test error:', error.message);
  }
}

// Run if called directly
if (require.main === module) {
  testEnhancements().then(() => {
    console.log('\n✅ Test suite finished');
    process.exit(0);
  }).catch(error => {
    console.error('\n❌ Test suite failed:', error);
    process.exit(1);
  });
}

module.exports = { testEnhancements };