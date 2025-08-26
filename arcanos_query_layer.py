from openai import OpenAI
import os

class ArcanosQueryLayer:
    def __init__(self, api_key=None):
        self.client = OpenAI(api_key=api_key or os.getenv("OPENAI_API_KEY"))

        self.memory_collections = {
            "guides": "memory_guides_v2",
            "patterns": "memory_patterns_v2",
            "sessions": "memory_sessions_v2"
        }

    def validate_params(self, prompt, top_k, fallback):
        if not prompt or not isinstance(prompt, str):
            raise ValueError("Invalid prompt supplied to query layer.")
        if top_k is not None and (not isinstance(top_k, int) or top_k < 1):
            raise ValueError("top_k must be a positive integer.")
        if fallback is not None and not isinstance(fallback, bool):
            raise ValueError("fallback must be a boolean.")

    def query(
        self,
        prompt,
        collection_hint=None,
        top_k=3,
        fallback=True
    ):
        self.validate_params(prompt, top_k, fallback)

        target_collection = (
            self.memory_collections.get(collection_hint, None)
            if collection_hint else None
        )

        search_payload = {
            # 🔥 Switched from gpt-4-turbo to your fine-tuned ARCANOS model
            "model": "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are ARCANOS, performing structured memory search. "
                        "Match user intent against memory fields: title, type, tags, data. "
                        "Return top matches with confidence scores."
                    )
                },
                {
                    "role": "user",
                    "content": (
                        f"Prompt: {prompt}\n"
                        f"Collection: {target_collection or 'ANY'}\n"
                        f"Fields: title, type, tags, data\n"
                        f"Top_k: {top_k}\n"
                        f"Fallback_matching: {fallback}\n"
                    )
                }
            ],
            "temperature": 0.2,
        }

        response = self.client.chat.completions.create(**search_payload)
        return response.choices[0].message.content

    def log_query(self, prompt, result):
        # Optional: Implement logging to memory or external audit service
        pass
