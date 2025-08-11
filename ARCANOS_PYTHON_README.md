# ARCANOS Strict GPT-5 Module

This Python module provides strict GPT-5 reasoning functionality with no fallback options, implementing the requirements specified in the problem statement.

## Features

- **Strict GPT-5 Enforcement**: Only uses the specified ARCANOS fine-tuned model, raises errors if unavailable
- **Maintenance Agent Integration**: Automatically alerts maintenance agent on failures
- **No Fallback Policy**: Ensures consistent GPT-5 reasoning without model degradation

## Installation

1. Install Python dependencies:
```bash
pip install -r requirements.txt
```

2. Set up environment variables:
```bash
export OPENAI_API_KEY="your-openai-api-key"
```

## Usage

### Basic Usage

```python
import arcanos_strict

# Call ARCANOS with strict GPT-5 enforcement
try:
    response = arcanos_strict.call_arcanos_strict(
        "Analyze this complex system architecture",
        temperature=0.1,
        max_tokens=500
    )
    print(response.choices[0].message.content)
except RuntimeError as e:
    print(f"ARCANOS unavailable: {e}")
```

### Function Reference

#### `call_arcanos_strict(prompt, **kwargs)`

Calls ARCANOS fine-tune with GPT-5 reasoning ONLY.

**Parameters:**
- `prompt` (str): The input prompt for ARCANOS processing
- `**kwargs`: Additional parameters for the OpenAI API call (temperature, max_tokens, etc.)

**Returns:**
- OpenAI ChatCompletion response object

**Raises:**
- `RuntimeError`: If GPT-5 is unavailable or unexpected model is used

#### `alert_maintenance_agent(message)`

Sends a request to the ARCANOS maintenance agent assistant.

**Parameters:**
- `message` (str): Alert message to send to the maintenance agent

## Configuration

The module uses the following configuration:

- **ARCANOS_FINE_TUNE_ID**: `"ft:your-arcanos-finetune-id"` (update with your actual fine-tune ID)
- **Maintenance Agent ID**: `"asst_LhMO3urEF0nBqph5bA65MMu"` (update with your actual assistant ID)

## Error Handling

The module implements strict error handling:

1. **Model Validation**: Verifies that responses come from the correct ARCANOS model
2. **Automatic Alerting**: Sends alerts to maintenance agent on any failures
3. **No Silent Failures**: All errors are logged and re-raised

## Testing

Run the test suite:

```bash
python tests/test_arcanos_strict.py
```

## Integration with TypeScript Codebase

This Python module can be used alongside the existing TypeScript ARCANOS implementation:

1. **Subprocess Integration**: Call Python functions from Node.js using child_process
2. **API Bridge**: Create HTTP endpoints that bridge between Python and TypeScript
3. **Shared Configuration**: Use environment variables for consistent configuration

## Security Considerations

- Never commit API keys to version control
- Use environment variables for sensitive configuration
- Monitor maintenance agent alerts for system health
- Regularly validate model IDs and assistant configurations