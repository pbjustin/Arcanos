#!/usr/bin/env python3
"""
ARCANOS Strict GPT-5 Example Usage

This script demonstrates how to use the ARCANOS strict module
for GPT-5 only reasoning with maintenance agent alerting.
"""

import os
import sys
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Import ARCANOS strict module
try:
    import arcanos_strict
except ImportError as e:
    print(f"Error importing arcanos_strict module: {e}")
    print("Make sure you're running this from the correct directory.")
    sys.exit(1)

def main():
    """Main demonstration function."""
    print("ARCANOS Strict GPT-5 Example")
    print("=" * 40)
    
    # Check if API key is configured
    if not os.getenv("OPENAI_API_KEY"):
        print("⚠️  Warning: OPENAI_API_KEY not set in environment")
        print("   Set it with: export OPENAI_API_KEY='your-key-here'")
        print("   This example will simulate the API calls.\n")
    
    # Example 1: Basic ARCANOS call
    print("Example 1: Basic ARCANOS Strict Call")
    print("-" * 35)
    
    prompt = "Perform a comprehensive system analysis of a distributed microservices architecture with focus on scalability, reliability, and performance optimization."
    
    try:
        print(f"Prompt: {prompt}")
        print("Calling ARCANOS with strict GPT-5 enforcement...")
        
        response = arcanos_strict.call_arcanos_strict(
            prompt,
            temperature=0.1,
            max_tokens=500
        )
        
        print("✅ Success! ARCANOS response received.")
        print(f"Model used: {response.model}")
        print(f"Response: {response.choices[0].message.content[:200]}...")
        
    except RuntimeError as e:
        print(f"❌ ARCANOS strict enforcement failed: {e}")
        print("   Maintenance agent has been alerted.")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
    
    print("\n" + "=" * 40)
    
    # Example 2: Complex reasoning task
    print("Example 2: Complex Reasoning Task")
    print("-" * 33)
    
    complex_prompt = """
    Design a comprehensive security audit framework for a multi-tenant SaaS platform that includes:
    1. Authentication and authorization mechanisms
    2. Data encryption strategies (at rest and in transit)
    3. API security best practices
    4. Compliance requirements (SOC2, GDPR, HIPAA)
    5. Incident response procedures
    6. Continuous monitoring and threat detection
    
    Provide detailed implementation steps and security controls for each component.
    """
    
    try:
        print("Complex reasoning task for ARCANOS...")
        
        response = arcanos_strict.call_arcanos_strict(
            complex_prompt.strip(),
            temperature=0.05,  # Lower temperature for precise analysis
            max_tokens=1000
        )
        
        print("✅ Complex analysis completed successfully!")
        print(f"Model: {response.model}")
        print(f"Analysis preview: {response.choices[0].message.content[:300]}...")
        
    except RuntimeError as e:
        print(f"❌ Complex analysis failed: {e}")
        print("   Maintenance agent alerted for investigation.")
    except Exception as e:
        print(f"❌ Unexpected error during complex analysis: {e}")
    
    print("\n" + "=" * 40)
    
    # Example 3: Direct maintenance agent test
    print("Example 3: Direct Maintenance Agent Alert")
    print("-" * 38)
    
    try:
        print("Testing maintenance agent alerting...")
        
        test_message = "Test alert from ARCANOS Python module - system operational check"
        arcanos_strict.alert_maintenance_agent(test_message)
        
        print("✅ Maintenance agent alert sent successfully!")
        print(f"Message: {test_message}")
        
    except Exception as e:
        print(f"❌ Failed to alert maintenance agent: {e}")
    
    print("\n" + "=" * 40)
    print("Demo completed. Check maintenance agent for alerts.")

if __name__ == "__main__":
    main()