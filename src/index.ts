import express, { Request, Response, NextFunction } from 'express';
import * as dotenv from 'dotenv';
import router from './routes/index';

// Load environment variables
dotenv.config();

// Check for fine-tuned model but allow startup without it
if (!process.env.FINE_TUNED_MODEL || process.env.FINE_TUNED_MODEL.trim() === '') {
  console.info("ℹ️ No fine-tuned model configured.");
} else {
  console.log("✅ Fine-tuned model loaded:", process.env.FINE_TUNED_MODEL);
}
if (!process.env.OPENAI_API_KEY) {
  throw new Error("❌ Missing OPENAI_API_KEY in environment variables.");
}

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api', router);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Add fallback error handler middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error("🔥 Fatal Error:", err);
  res.status(500).json({ error: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;