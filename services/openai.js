module.exports = {
  callOpenAI: async function (model, payload) {
    const openai = require("./client"); // Adjust import path if needed
    const response = await openai.createChatCompletion({
      model,
      messages: payload.messages,
      max_tokens: 1300, // 🔒 Hardcoded limit
      ...payload.options,
    });
    return response.data;
  },
};
