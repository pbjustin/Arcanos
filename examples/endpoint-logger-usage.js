#!/usr/bin/env node
// Example usage of the endpoint logger
// This demonstrates the exact usage pattern from the problem statement
import express from 'express';
import { logEndpointCall } from '../src/services/endpoint-logger';
const app = express();
app.use(express.json());
// ✅ EXAMPLE USAGE - Exact implementation from problem statement
app.get('/api/canon/files', (req, res) => {
    logEndpointCall('/api/canon/files', req);
    // ...your logic
    res.json({ message: 'Example endpoint with logging' });
});
// Additional example endpoints to show versatility
app.get('/api/users/:id', (req, res) => {
    logEndpointCall(`/api/users/${req.params.id}`, req);
    res.json({ user: req.params.id });
});
app.post('/api/data', (req, res) => {
    logEndpointCall('/api/data', req);
    res.json({ message: 'Data received', body: req.body });
});
// Start server
const PORT = 3001;
app.listen(PORT, () => {
    console.log(`Example server running on port ${PORT}`);
    console.log('Test with:');
    console.log(`  curl http://localhost:${PORT}/api/canon/files`);
    console.log(`  curl http://localhost:${PORT}/api/users/123`);
    console.log(`  curl -X POST -d '{"test": "data"}' -H "Content-Type: application/json" http://localhost:${PORT}/api/data`);
});
