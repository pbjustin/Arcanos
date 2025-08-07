export async function queryFinetune(prompt: string) {
  const apiKey = process.env.API_KEY;
  const model = process.env.AI_MODEL;

  if (!apiKey || !model) {
    return { error: "Missing API configuration." };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return { error: `API request failed: ${response.status} ${errText}` };
    }

    const data = await response.json();
    return { result: data.choices?.[0]?.message?.content ?? "No response." };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}
