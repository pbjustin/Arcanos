import express, { Request, Response } from 'express';
import BackstageBooker, { MatchInput, Wrestler } from '../modules/backstage/booker.js';

const router = express.Router();

// Entry point for Backstage Booker
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'success',
    module: 'Backstage Booker',
    role: 'entrypoint',
    timestamp: Date.now()
  });
});

// Book Event
router.post('/book-event', async (req: Request, res: Response) => {
  try {
    const eventID = await BackstageBooker.bookEvent(req.body);
    res.status(200).json({ success: true, eventID });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Simulate Match
router.post('/simulate-match', async (req: Request, res: Response) => {
  try {
    const { match, rosters, winProbModifier }: { match: MatchInput; rosters: Wrestler[]; winProbModifier?: number } = req.body;
    const result = await BackstageBooker.simulateMatch(match, rosters, winProbModifier || 0);
    res.status(200).json({ success: true, result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update Roster
router.post('/update-roster', async (req: Request, res: Response) => {
  try {
    const roster = await BackstageBooker.updateRoster(req.body as Wrestler[]);
    res.status(200).json({ success: true, roster });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Track Storyline
router.post('/track-storyline', async (req: Request, res: Response) => {
  try {
    const storyline = await BackstageBooker.trackStoryline(req.body);
    res.status(200).json({ success: true, storyline });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;

