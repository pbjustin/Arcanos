import { Probot } from "probot";
import { OpenAI } from "openai";

export default (app) => {
  app.on("pull_request.opened", async (context) => {
    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });

    const pr = context.payload.pull_request;
    const prNumber = pr.number;
    const repo = context.repo();

    const files = await context.octokit.pulls.listFiles({
      ...repo,
      pull_number: prNumber,
    });

    for (const file of files.data) {
      if (!file.patch || file.status === "added") continue;

      const diff = file.patch;

      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "system",
            content: `
You are ARCANOS — an expert refactor assistant. You must:
- Remove bloated, outdated, or legacy code.
- Improve clarity, performance, and modularity.
- Modernize syntax with idiomatic best practices.
Respond only with specific inline review comments or suggestions.
`,
          },
          {
            role: "user",
            content: `Review this code diff:\n\n${diff}`,
          },
        ],
        temperature: 0.3,
      });

      const comment = completion.choices[0].message.content;

      await context.octokit.issues.createComment({
        ...repo,
        issue_number: prNumber,
        body: `### 🧠 ARCANOS Refactor Review for \`${file.filename}\`\n\n${comment}`,
      });
    }
  });
};