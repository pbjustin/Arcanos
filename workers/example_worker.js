// workers/example_worker.js

// Note: This worker demonstrates the problem statement requirements
// The project uses ES modules ("type": "module" in package.json),
// so we use export default instead of module.exports

export default {
  name: "Example Worker", // Display name in logs
  schedule: "*/5 * * * *", // Run every 5 minutes (cron syntax)
  
  run: async (context) => {
    context.log("Example Worker started.");
    
    // Example: Query the database (if connected)
    try {
      const result = await context.db.query("SELECT NOW() as current_time");
      context.log(`Database time: ${result.rows[0].current_time}`);
    } catch (err) {
      context.error("Database query failed:", err.message);
    }
    
    // Example: Do some AI processing
    try {
      const aiResponse = await context.ai.ask("Say hello from the Example Worker.");
      context.log(`AI says: ${aiResponse}`);
    } catch (err) {
      context.error("AI request failed:", err.message);
    }
    
    context.log("Example Worker finished.");
  }
};