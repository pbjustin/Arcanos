const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

// Your routes and memory handlers go here
app.get('/', (req, res) => res.send('ARCANOS backend running'));
app.use('/api/memory', require('./routes/memory')); // Example

// Prevent shutdown: Start persistent listener
app.listen(PORT, () => {
  console.log(`✅ Server listening on port ${PORT}`);
});
