import shortterm from '../modules/shortterm.js';

export default function updateGoal(goal) {
  const data = shortterm.read();
  data.goals = data.goals || [];
  const existing = data.goals.find(g => g.id === goal.id);
  if (existing) {
    Object.assign(existing, goal);
  } else {
    data.goals.push(goal);
  }
  shortterm.write(data);
  return { updated: true, goal };
}
