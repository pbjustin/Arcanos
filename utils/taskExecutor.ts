export async function executeTask(prompt: string) {
  const lower = prompt.toLowerCase();

  if (lower.includes("track goal")) {
    return { task: "Goal Tracker", status: "📌 Goal tracker initialized" };
  }

  if (lower.includes("summarize")) {
    return { task: "Summary", status: "🧠 Summary routine activated" };
  }

  if (lower.includes("generate report")) {
    return { task: "Report Generator", status: "📄 Report generation started" };
  }

  return {
    task: "Unknown",
    status: "⚠️ Command not recognized. Please rephrase or route to a known module.",
  };
}
