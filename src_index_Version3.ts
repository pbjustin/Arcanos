import express from 'express';
import cors from 'cors';
import apiRoutes from './routes/api.route.js';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/api', apiRoutes);

app.get('/health', (_req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server live at http://0.0.0.0:${PORT}`);
});