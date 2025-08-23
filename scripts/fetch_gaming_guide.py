from openai import OpenAI
import os

# Initialize client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def fetch_gaming_guide(game_name, topic):
    """
    Fetches a guide/tutorial/strategy from Arcanos Gaming backend.
    Falls back gracefully if no data is found.
    """

    query_prompt = f"Retrieve guide for {game_name}, topic: {topic}."

    response = client.chat.completions.create(
        model="gpt-4.1",  # or your configured Arcanos Gaming model
        messages=[
            {"role": "system", "content": "You are Arcanos Gaming, a hallucination-safe gaming guide engine."},
            {"role": "user", "content": query_prompt}
        ]
    )

    content = response.choices[0].message.content.strip()

    if "Not Found" in content:
        return f"No verified guide available for {game_name} - {topic}."
    return content

if __name__ == "__main__":
    print(fetch_gaming_guide("Elden Ring", "Best Sorcery Build Patch 1.X"))
