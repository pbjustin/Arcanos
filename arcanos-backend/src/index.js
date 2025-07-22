const express = require('express');
const app = express();
const arcanosRoute = require('./routes/arcanos');

app.use(express.json());
app.use('/arcanos', arcanosRoute);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ARCANOS backend running on port ${PORT}`));
