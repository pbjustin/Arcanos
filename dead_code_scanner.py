#!/usr/bin/env python3
"""
ARCANOS Dead Code Scanner
Automated dead code detection tool for multi-language projects.
Integrates with OpenAI Maintenance Agent for AI-powered recommendations.
"""

import os
import subprocess
import sys

# Try to import openai, but gracefully handle if not available
try:
    import openai
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    print("Warning: OpenAI SDK not available. AI analysis will be skipped.")

# ===== CONFIG =====
BASE_DIR = os.path.dirname(os.path.abspath(__file__))  # Use current repository root
REPORT_FILE = "dead_code_report.txt"

# Load OpenAI configuration if available
if OPENAI_AVAILABLE:
    openai.api_key = os.getenv("OPENAI_API_KEY")
    MAINTENANCE_AGENT_ID = os.getenv("ARCANOS_MAINTENANCE_AGENT", "asst_LhMO3urEF0nBqph5bA65MMu")

# ===== TOOL COMMANDS =====
tools = {
    ".py": ["python3", os.path.join(BASE_DIR, "find_unused_code.py")],  # Our Python script
    ".js": ["npx", "eslint"],
    ".ts": ["npx", "eslint"],
    ".go": ["staticcheck", "./..."],  # Only if staticcheck is available
}

def check_tool_availability():
    """Check which tools are available and adjust the tools dict accordingly."""
    available_tools = {}
    
    # Python script should always be available
    if os.path.exists(os.path.join(BASE_DIR, "find_unused_code.py")):
        available_tools[".py"] = tools[".py"]
    
    # Check for eslint
    try:
        result = subprocess.run(["npx", "eslint", "--version"], 
                              capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            available_tools[".js"] = tools[".js"]
            available_tools[".ts"] = tools[".ts"]
        else:
            print("Warning: ESLint not available. JavaScript/TypeScript analysis will be skipped.")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        print("Warning: ESLint not available. JavaScript/TypeScript analysis will be skipped.")
    
    # Check for staticcheck
    try:
        result = subprocess.run(["staticcheck", "--version"], 
                              capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            available_tools[".go"] = tools[".go"]
        else:
            print("Info: staticcheck not available. Go analysis will be skipped.")
    except (subprocess.TimeoutExpired, FileNotFoundError):
        print("Info: staticcheck not available. Go analysis will be skipped.")
    
    return available_tools

def get_files_to_scan(base_dir, extensions):
    """Get list of files to scan based on available tools."""
    files_to_scan = []
    
    # Directories to skip
    skip_dirs = {
        'node_modules', '.git', '__pycache__', 'dist', 'build', 
        '.venv', 'venv', 'env', '.env', 'logs', 'tmp'
    }
    
    for root, dirs, files in os.walk(base_dir):
        # Remove skip directories from the dirs list to avoid traversing them
        dirs[:] = [d for d in dirs if d not in skip_dirs]
        
        for file in files:
            ext = os.path.splitext(file)[1]
            if ext in extensions:
                files_to_scan.append((os.path.join(root, file), ext))
    
    return files_to_scan

def scan_files():
    """Runs the right dead-code tool based on file type and appends to the report."""
    available_tools = check_tool_availability()
    
    if not available_tools:
        print("Error: No analysis tools are available.")
        return False
    
    print(f"Available tools: {list(available_tools.keys())}")
    
    files_to_scan = get_files_to_scan(BASE_DIR, available_tools.keys())
    
    if not files_to_scan:
        print("No files found to scan.")
        return False
    
    print(f"Found {len(files_to_scan)} files to scan.")
    
    with open(REPORT_FILE, "w", encoding="utf-8") as report:
        report.write("# ARCANOS Dead Code Analysis Report\n")
        report.write(f"# Base Directory: {BASE_DIR}\n")
        report.write(f"# Generated: {subprocess.run(['date'], capture_output=True, text=True).stdout.strip()}\n\n")
        
        files_with_issues = 0
        files_processed = 0
        
        for file_path, ext in files_to_scan:
            if ext not in available_tools:
                continue
                
            files_processed += 1
            if files_processed % 10 == 0:
                print(f"Processed {files_processed}/{len(files_to_scan)} files...")
                
            cmd = available_tools[ext]
            rel_path = os.path.relpath(file_path, BASE_DIR)
            
            try:
                # For Python files, pass the specific file
                if ext == ".py":
                    result = subprocess.run(
                        cmd + [file_path],
                        capture_output=True,
                        text=True,
                        timeout=10  # Reduced timeout for faster processing
                    )
                else:
                    # For JS/TS, run eslint on the specific file
                    if ext in [".js", ".ts"]:
                        eslint_cmd = ["npx", "eslint", file_path]
                        result = subprocess.run(
                            eslint_cmd,
                            capture_output=True,
                            text=True,
                            timeout=15  # Reduced timeout
                        )
                    else:
                        # For Go, run in the file's directory
                        result = subprocess.run(
                            cmd,
                            cwd=os.path.dirname(file_path),
                            capture_output=True,
                            text=True,
                            timeout=15
                        )
                
                # Only log significant issues, not minor warnings
                stdout_content = result.stdout.strip()
                stderr_content = result.stderr.strip()
                
                # Filter out common ESLint setup warnings
                if ext in [".js", ".ts"] and stdout_content:
                    lines = stdout_content.split('\n')
                    significant_lines = [line for line in lines 
                                       if 'no-unused-vars' in line or 'no-unreachable' in line]
                    stdout_content = '\n'.join(significant_lines)
                
                if stdout_content or (stderr_content and "error" in stderr_content.lower()):
                    files_with_issues += 1
                    report.write(f"\n## {rel_path} ({ext})\n")
                    if stdout_content:
                        report.write("### Issues Found:\n")
                        report.write(stdout_content)
                        report.write("\n")
                    if stderr_content and "error" in stderr_content.lower():
                        report.write("### Errors:\n")
                        report.write(stderr_content)
                        report.write("\n")
                        
            except subprocess.TimeoutExpired:
                report.write(f"\n## {rel_path} ({ext})\n")
                report.write("[WARNING] Analysis timed out (file may be too large or complex)\n")
            except Exception as e:
                report.write(f"\n## {rel_path} ({ext})\n")
                report.write(f"[ERROR] Could not analyze: {e}\n")
        
        if files_with_issues == 0:
            report.write("\n✅ No dead code issues detected in scanned files.\n")
        else:
            report.write(f"\n📊 Analysis complete. Found issues in {files_with_issues} files out of {files_processed} processed.\n")
    
    return True

def send_report_to_ai():
    """Sends the report to Maintenance Agent for AI review."""
    if not OPENAI_AVAILABLE:
        print("📝 Report generated, but OpenAI integration not available.")
        return
    
    if not openai.api_key:
        print("📝 Report generated, but OPENAI_API_KEY not set.")
        return
    
    try:
        with open(REPORT_FILE, "r", encoding="utf-8") as f:
            content = f.read()

        if not content.strip() or "No dead code issues detected" in content:
            print("✅ No dead code found.")
            return

        # Use the updated OpenAI SDK
        client = openai.OpenAI()
        thread = client.beta.threads.create()
        
        client.beta.threads.messages.create(
            thread_id=thread.id,
            role="user",
            content=f"Dead code scan report:\n\n{content}\n\nPlease suggest safe removals and improvements."
        )
        
        run = client.beta.threads.runs.create(
            thread_id=thread.id,
            assistant_id=MAINTENANCE_AGENT_ID
        )
        
        print(f"📤 Report sent to Maintenance Agent for review. Thread ID: {thread.id}")
        print(f"📋 Run ID: {run.id}")
        
    except Exception as e:
        print(f"[ERROR] Could not send report to AI: {e}")

def main():
    """Main function."""
    print("🔍 ARCANOS Dead Code Scanner")
    print(f"📁 Scanning directory: {BASE_DIR}")
    
    # Add a test mode for faster validation
    if "--test" in sys.argv:
        print("🧪 Running in test mode (limited files)")
        global REPORT_FILE
        REPORT_FILE = "dead_code_test_report.txt"
        
        # Override get_files_to_scan to limit files for testing
        original_get_files = globals()['get_files_to_scan']
        def limited_get_files(base_dir, extensions):
            all_files = original_get_files(base_dir, extensions)
            # Limit to first 5 files of each type for testing
            limited = []
            type_counts = {}
            for file_path, ext in all_files:
                if type_counts.get(ext, 0) < 5:
                    limited.append((file_path, ext))
                    type_counts[ext] = type_counts.get(ext, 0) + 1
            return limited
        globals()['get_files_to_scan'] = limited_get_files
    
    if not scan_files():
        sys.exit(1)
    
    print(f"📄 Report saved to {REPORT_FILE}")
    
    # Send to AI if configured and not in test mode
    if "--test" not in sys.argv:
        send_report_to_ai()
    
    # Display summary
    if os.path.exists(REPORT_FILE):
        with open(REPORT_FILE, "r", encoding="utf-8") as f:
            content = f.read()
            print(f"\n📋 Report Summary:")
            lines = content.split('\n')
            for line in lines[-10:]:  # Show last 10 lines for summary
                if line.strip():
                    print(f"   {line}")

if __name__ == "__main__":
    main()