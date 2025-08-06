// testStatus.js

const https = require('https');

const options = {
  hostname: 'arcanos-v2-production.up.railway.app',
  path: '/status',
  method: 'GET',
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('✅ /status response received:');
      console.log(JSON.stringify(json, null, 2));
    } catch (err) {
      console.error('❌ Failed to parse /status response:', err.message);
    }
  });
});

req.on('error', (error) => {
  console.error('❌ Request failed:', error.message);
});

req.end();