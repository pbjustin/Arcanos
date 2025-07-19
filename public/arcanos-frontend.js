// ======== FRONTEND: Fallback Consent Logic =========
const sendMessage = async (userInput) => {
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: userInput,
        domain: "general",
        useRAG: true,
        useHRC: true
      }),
    });

    const data = await response.json();

    if (data.error?.includes("Fallback not allowed")) {
      const proceed = window.confirm(
        "The fine-tuned model is offline. Do you want to fall back to the default model?"
      );
      if (!proceed) return alert("Operation canceled.");

      const fallbackResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          messages: [{ role: "user", content: userInput }],
        }),
      });

      const fallbackData = await fallbackResponse.json();
      console.log("Fallback output:", fallbackData.choices[0].message.content);
    } else {
      console.log("Arcanos response:", data.response);
    }
  } catch (err) {
    console.error("Unhandled exception:", err);
  }
};

// Export for use in other modules if needed
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { sendMessage };
}