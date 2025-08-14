const express = require('express');
const router = express.Router();
const matchEngine = require('./services/matchengine');

router.post('/book-event', async (req, res) => {
    res.status(501).json({ success: false, error: 'Not implemented' });
});

router.post('/simulate-match', async (req, res) => {
    try {
        const result = await matchEngine.simulateMatch(req.body.match, req.body.rosters, req.body.winProbModifier || 0);
        res.status(200).json({ success: true, result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/update-roster', async (req, res) => {
    res.status(501).json({ success: false, error: 'Not implemented' });
});

router.post('/track-storyline', async (req, res) => {
    res.status(501).json({ success: false, error: 'Not implemented' });
});

module.exports = router;
