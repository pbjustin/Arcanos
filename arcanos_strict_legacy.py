"""
ARCANOS Strict GPT-5 Module - Legacy OpenAI SDK Compatibility

This module provides the exact implementation shown in the problem statement,
using the legacy OpenAI SDK syntax for backward compatibility.
"""

import openai
import os

# Configure OpenAI API key from environment
openai.api_key = os.getenv("OPENAI_API_KEY")

# Set your fine-tuned ARCANOS model ID  
ARCANOS_FINE_TUNE_ID = "ft:your-arcanos-finetune-id"

def call_arcanos_strict(prompt, **kwargs):
    """
    Calls ARCANOS fine-tune with GPT-5 reasoning ONLY.
    If unavailable, raises an error and alerts Maintenance Agent.
    
    This is the exact implementation from the problem statement.
    """
    try:
        response = openai.ChatCompletion.create(
            model=ARCANOS_FINE_TUNE_ID,  # Your fine-tune
            messages=[{"role": "user", "content": prompt}],
            **kwargs
        )
        
        # Ensure response model is correct
        if response.model != ARCANOS_FINE_TUNE_ID:
            raise RuntimeError(f"Unexpected model used: {response.model}")

        return response

    except Exception as e:
        # Log and escalate to Maintenance Agent
        print(f"[ERROR] ARCANOS + GPT-5 unavailable: {e}")
        alert_maintenance_agent(f"Strict lock failure: {e}")
        raise

def alert_maintenance_agent(message):
    """
    Sends a request to your ARCANOS_MAINTENANCE_AGENT assistant.
    
    This is the exact implementation from the problem statement.
    """
    try:
        openai.beta.threads.create(
            assistant_id="asst_LhMO3urEF0nBqph5bA65MMu",  # Maintenance Agent ID
            messages=[{"role": "user", "content": message}]
        )
    except Exception as e:
        print(f"[ERROR] Failed to alert Maintenance Agent: {e}")