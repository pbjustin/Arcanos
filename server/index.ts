import express from 'express';
import askRoutes from './routes/index';

const app = express();
app.use(express.json());
app.use('/', askRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});