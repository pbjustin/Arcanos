"""
ARCANOS Strict GPT-5 Module

This module provides strict GPT-5 reasoning functionality with no fallback options.
Implements the requirements specified in the problem statement, updated for modern OpenAI SDK.
"""

import os
from openai import OpenAI

# Initialize OpenAI client with API key from environment
# Use placeholder key for testing if not set
api_key = os.getenv("OPENAI_API_KEY", "sk-test-key-for-testing")
client = OpenAI(api_key=api_key)

# Set your fine-tuned ARCANOS model ID
ARCANOS_FINE_TUNE_ID = "ft:your-arcanos-finetune-id"

def call_arcanos_strict(prompt, **kwargs):
    """
    Calls ARCANOS fine-tune with GPT-5 reasoning ONLY.
    If unavailable, raises an error and alerts Maintenance Agent.
    
    Args:
        prompt (str): The input prompt for ARCANOS processing
        **kwargs: Additional parameters for the OpenAI API call
        
    Returns:
        OpenAI ChatCompletion response object
        
    Raises:
        RuntimeError: If GPT-5 is unavailable or unexpected model is used
    """
    try:
        response = client.chat.completions.create(
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
    
    Args:
        message (str): Alert message to send to the maintenance agent
    """
    try:
        # Create a thread with the maintenance agent
        thread = client.beta.threads.create()
        
        # Add the message to the thread
        client.beta.threads.messages.create(
            thread_id=thread.id,
            role="user",
            content=message
        )
        
        # Create a run with the maintenance agent
        client.beta.threads.runs.create(
            thread_id=thread.id,
            assistant_id="asst_LhMO3urEF0nBqph5bA65MMu"  # Maintenance Agent ID
        )
        
    except Exception as e:
        print(f"[ERROR] Failed to alert Maintenance Agent: {e}")