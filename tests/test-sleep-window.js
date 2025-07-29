// Test Sleep Window Functionality
const { safeRequire } = require('./scripts/codex-internal');
const { getCurrentSleepWindowStatus, shouldReduceServerActivity, logSleepWindowStatus } = safeRequire('./dist/services/sleep-config');

console.log('🌙 Testing ARCANOS Sleep Window System');
console.log('=====================================');
console.log('');

try {
  // Test current sleep window status
  const sleepStatus = getCurrentSleepWindowStatus();
  console.log('Sleep Window Status:');
  console.log('  - In Sleep Window:', sleepStatus.inSleepWindow);
  console.log('  - Next Sleep Start:', sleepStatus.nextSleepStart?.toLocaleString());
  console.log('  - Next Sleep End:', sleepStatus.nextSleepEnd?.toLocaleString());
  console.log('  - Minutes Until Sleep:', sleepStatus.timeUntilSleep);
  console.log('  - Minutes Until Wake:', sleepStatus.timeUntilWake);
  console.log('');

  // Test activity reduction
  const shouldReduce = shouldReduceServerActivity();
  console.log('Server Activity Reduction:');
  console.log('  - Should Reduce Activity:', shouldReduce);
  console.log('');

  // Test logging
  console.log('Sleep Window Status Log:');
  logSleepWindowStatus();
  console.log('');

  // Test Eastern Time conversion
  const now = new Date();
  const easternTime = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  console.log('Time Information:');
  console.log('  - Current UTC Time:', now.toISOString());
  console.log('  - Current Eastern Time:', easternTime.toLocaleString());
  console.log('  - Eastern Hour:', easternTime.getHours());
  console.log('  - Sleep Window (7 AM - 2 PM ET):', easternTime.getHours() >= 7 && easternTime.getHours() < 14 ? 'ACTIVE' : 'INACTIVE');
  console.log('');

  console.log('✅ Sleep window functionality test completed successfully!');
  
} catch (error) {
  console.error('❌ Sleep window test failed:', error.message);
  console.error(error);
}