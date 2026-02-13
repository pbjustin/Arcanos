export async function runReflection(
  callGPT: Function,
  draft: string,
  budget: any,
  watchdog: any
) {
  budget.increment();
  watchdog.check();

  return await callGPT({
    messages: [
      {
        role: "user",
        content:
          `Critique this for logical flaws, scaling risk, ` +
          `security weaknesses, and hidden assumptions:\n\n${draft}`
      }
    ],
    max_tokens: 600
  });
}
