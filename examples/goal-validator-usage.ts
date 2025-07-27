#!/usr/bin/env node
import { validateGoalInput } from '../src/utils/goal-validator';
import { HRCCore } from '../src/modules/hrc';

(async () => {
  const hrc = new HRCCore();
  await hrc.initialize();

  const sampleGoal = {
    userId: 'user-123',
    title: 'Finish project documentation',
    description: 'Complete the remaining sections of the project docs',
    priority: 'high',
    progress: 40
  };

  try {
    const validated = await validateGoalInput(sampleGoal, hrc);
    console.log('Validated goal:', validated);
  } catch (error) {
    console.error('Validation failed:', error);
  }
})();
