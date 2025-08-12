"""
TypeScript-Python Integration Example

This demonstrates how the Python ARCANOS strict module can be integrated
with the existing TypeScript/Node.js codebase.
"""

import subprocess
import json
import sys
import os

def call_typescript_arcanos(prompt):
    """
    Call the TypeScript ARCANOS implementation and compare with Python strict version.
    
    Args:
        prompt (str): Input prompt for processing
        
    Returns:
        dict: Comparison results from both implementations
    """
    # Import our Python strict implementation
    try:
        import arcanos_strict
    except ImportError:
        return {"error": "Python ARCANOS strict module not available"}
    
    results = {
        "prompt": prompt,
        "python_strict": None,
        "typescript_fallback": None,
        "comparison": {}
    }
    
    # Try Python strict implementation first
    try:
        print("🐍 Attempting Python ARCANOS strict call...")
        python_response = arcanos_strict.call_arcanos_strict(
            prompt,
            temperature=0.1,
            max_tokens=500
        )
        results["python_strict"] = {
            "success": True,
            "model": python_response.model,
            "content": python_response.choices[0].message.content,
            "usage": python_response.usage._asdict() if python_response.usage else None
        }
        print("✅ Python strict call successful")
        
    except Exception as e:
        results["python_strict"] = {
            "success": False,
            "error": str(e),
            "maintenance_alerted": True
        }
        print(f"❌ Python strict call failed: {e}")
    
    # Try TypeScript implementation with fallback capability
    try:
        print("🟨 Attempting TypeScript ARCANOS call...")
        
        # Prepare the API call to the TypeScript server
        # This would normally be an HTTP request to the running server
        ts_command = [
            "node", "-e", f"""
            const {{ runARCANOS }} = require('./dist/logic/arcanos.js');
            const {{ getOpenAIClient }} = require('./dist/services/openai.js');
            
            async function test() {{
                try {{
                    const client = getOpenAIClient();
                    if (!client) {{
                        console.log(JSON.stringify({{
                            success: false,
                            error: "No OpenAI client available",
                            mock_mode: true
                        }}));
                        return;
                    }}
                    
                    const result = await runARCANOS(client, '{prompt}');
                    console.log(JSON.stringify({{
                        success: true,
                        result: result.result,
                        activeModel: result.activeModel,
                        fallbackFlag: result.fallbackFlag,
                        gpt5Used: result.gpt5Used
                    }}));
                }} catch (err) {{
                    console.log(JSON.stringify({{
                        success: false,
                        error: err.message
                    }}));
                }}
            }}
            
            test();
            """
        ]
        
        # Execute the TypeScript code
        ts_result = subprocess.run(
            ts_command, 
            cwd=os.path.dirname(os.path.abspath(__file__)),
            capture_output=True, 
            text=True
        )
        
        if ts_result.returncode == 0:
            ts_data = json.loads(ts_result.stdout.strip())
            results["typescript_fallback"] = ts_data
            print("✅ TypeScript call completed")
        else:
            results["typescript_fallback"] = {
                "success": False,
                "error": ts_result.stderr or "TypeScript execution failed"
            }
            print(f"❌ TypeScript call failed: {ts_result.stderr}")
            
    except Exception as e:
        results["typescript_fallback"] = {
            "success": False,
            "error": f"Integration error: {str(e)}"
        }
        print(f"❌ TypeScript integration failed: {e}")
    
    # Compare results
    if results["python_strict"] and results["typescript_fallback"]:
        py_success = results["python_strict"].get("success", False)
        ts_success = results["typescript_fallback"].get("success", False)
        
        results["comparison"] = {
            "both_successful": py_success and ts_success,
            "python_strict_enforced": py_success and not results["python_strict"].get("fallback", False),
            "typescript_fallback_used": ts_success and results["typescript_fallback"].get("fallbackFlag", False),
            "recommendation": "Use Python strict for GPT-5 only, TypeScript for graceful degradation"
        }
        
        if py_success and ts_success:
            results["comparison"]["consistency_check"] = {
                "models_match": (
                    results["python_strict"].get("model") == 
                    results["typescript_fallback"].get("activeModel")
                ),
                "python_model": results["python_strict"].get("model"),
                "typescript_model": results["typescript_fallback"].get("activeModel")
            }
    
    return results

def demonstrate_integration():
    """Demonstrate the integration between Python and TypeScript implementations."""
    print("ARCANOS TypeScript-Python Integration Demo")
    print("=" * 50)
    
    test_prompts = [
        "Analyze system performance bottlenecks in a microservices architecture",
        "Design a comprehensive security audit framework",
        "Optimize database query performance for large-scale applications"
    ]
    
    for i, prompt in enumerate(test_prompts, 1):
        print(f"\nTest {i}: {prompt[:50]}...")
        print("-" * 40)
        
        results = call_typescript_arcanos(prompt)
        
        # Display results
        if results.get("python_strict"):
            py_result = results["python_strict"]
            print(f"🐍 Python Strict: {'✅ Success' if py_result.get('success') else '❌ Failed'}")
            if py_result.get("success"):
                print(f"   Model: {py_result.get('model', 'Unknown')}")
            else:
                print(f"   Error: {py_result.get('error', 'Unknown error')}")
        
        if results.get("typescript_fallback"):
            ts_result = results["typescript_fallback"]
            print(f"🟨 TypeScript: {'✅ Success' if ts_result.get('success') else '❌ Failed'}")
            if ts_result.get("success"):
                print(f"   Model: {ts_result.get('activeModel', 'Unknown')}")
                print(f"   Fallback: {'Yes' if ts_result.get('fallbackFlag') else 'No'}")
            else:
                print(f"   Error: {ts_result.get('error', 'Unknown error')}")
        
        if results.get("comparison"):
            comp = results["comparison"]
            print(f"📊 Comparison:")
            print(f"   Both successful: {comp.get('both_successful', False)}")
            print(f"   Python strict enforced: {comp.get('python_strict_enforced', False)}")
            print(f"   TypeScript fallback used: {comp.get('typescript_fallback_used', False)}")
            print(f"   Recommendation: {comp.get('recommendation', 'N/A')}")

if __name__ == "__main__":
    demonstrate_integration()