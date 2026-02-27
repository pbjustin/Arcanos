import 'dotenv/config';

import { app } from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`ARCANOS running on port ${PORT}`);
});