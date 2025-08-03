import shortterm from './shortterm.js';
import { logEvent } from '../logEvent.js';

export default {
  async read() {
    const data = await shortterm.read();
    return data.goals || [];
  },
  async write(goals) {
    const data = await shortterm.read();
    data.goals = goals;
    await shortterm.write(data);
    await logEvent('goals');
  },
};
