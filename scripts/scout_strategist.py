"""Example script demonstrating scout and strategist layers."""
from openai import OpenAI
import requests

client = OpenAI()


def scout_search(query: str):
    """Perform a DuckDuckGo search and return summary sources."""
    resp = requests.get(
        f"https://api.duckduckgo.com/?q={query}&format=json"
    ).json()
    sources = []
    for topic in resp.get("RelatedTopics", []):
        if "Text" in topic and "FirstURL" in topic:
            sources.append(
                {
                    "title": topic["Text"],
                    "url": topic["FirstURL"],
                    "snippet": topic["Text"][:200],
                }
            )
    return {"query": query, "sources": sources[:5]}


def strategist_plan(evidence_packet):
    """Generate strategy based on evidence using GPT-5."""
    prompt = f"""
    You are ARCANOS Strategist. Based on the following evidence packet,
    produce a step-by-step strategy with citations.

    Evidence Packet:
    {evidence_packet}
    """
    response = client.chat.completions.create(
        model="gpt-5",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.3,
    )
    return response.choices[0].message.content


if __name__ == "__main__":
    query = "Elden Ring Malenia boss guide strategy"
    packet = scout_search(query)
    strategy = strategist_plan(packet)
    print("=== Evidence Packet ===")
    print(packet)
    print("\n=== Strategy Output ===")
    print(strategy)
