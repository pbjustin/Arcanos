const express = require('express');
const router = express.Router();
const processQuery = require('../logic/engine');

router.post('/', (req, res) => {
  const { query } = req.body;
  const result = processQuery(query);
  res.json(result);
});

module.exports = router;
