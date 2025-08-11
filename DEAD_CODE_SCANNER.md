# ARCANOS Dead Code Scanner

A comprehensive multi-language dead code detection tool for the ARCANOS repository.

## Features

- **Multi-language support**: Python, JavaScript, TypeScript, and Go (when staticcheck is available)
- **Intelligent analysis**: Uses AST parsing for Python and ESLint for JavaScript/TypeScript
- **AI integration**: Can send reports to OpenAI Maintenance Agent for intelligent recommendations
- **Configurable scanning**: Skip common directories and focus on source code
- **Detailed reporting**: Generates comprehensive reports with file-by-file analysis

## Usage

### Basic Usage

```bash
# Scan all supported files in the repository
python3 dead_code_scanner.py

# Test mode (limited files for faster validation)
python3 dead_code_scanner.py --test
```

### Prerequisites

1. **Python dependencies**: Install with `pip install -r requirements.txt`
2. **Node.js dependencies**: Install with `npm install`
3. **Optional - Go staticcheck**: Install for Go dead code analysis

### Configuration

Set the following environment variables for AI integration:

```bash
export OPENAI_API_KEY="your-openai-api-key"
export ARCANOS_MAINTENANCE_AGENT="your-assistant-id"
```

## Files

- `dead_code_scanner.py` - Main scanner script
- `find_unused_code.py` - Python AST-based dead code detector
- `eslint.config.js` - ESLint configuration for dead code detection

## Python Analysis

The Python analyzer detects:
- Unused functions (excluding special methods and AST visitors)
- Unused classes
- Unused imports (with smart filtering for common modules)
- Syntax errors

## JavaScript/TypeScript Analysis

Using ESLint with rules:
- `no-unused-vars` - Detects unused variables and functions
- `no-unreachable` - Detects unreachable code

## Output

The scanner generates a detailed report (`dead_code_report.txt`) containing:
- File-by-file analysis results
- Specific line numbers and issues
- Summary statistics
- Timestamp and configuration details

## Integration

The scanner can integrate with OpenAI's Maintenance Agent to provide:
- AI-powered analysis of dead code findings
- Safe removal recommendations
- Code improvement suggestions

## Example Output

```
🔍 ARCANOS Dead Code Scanner
📁 Scanning directory: /path/to/project
Available tools: ['.py', '.js', '.ts']
Found 50 files to scan.
Processed 10/50 files...
📄 Report saved to dead_code_report.txt
📤 Report sent to Maintenance Agent for review.
```