import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (_, res) => {
  res.status(200).send('OK');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});