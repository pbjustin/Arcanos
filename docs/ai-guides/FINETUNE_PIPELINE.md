# OpenAI Fine-Tuning Pipeline

A modular system for continuing fine-tuning of existing OpenAI models using the API. This pipeline enables human-controlled incremental refinement of models by processing new training data batches.

## 🎯 Overview

This system provides three modular CLI tools for managing the complete fine-tuning workflow:

- **`upload_jsonl.sh`** - Upload training data to OpenAI
- **`continue_finetune.sh`** - Start fine-tuning jobs on existing models  
- **`track_job.sh`** - Monitor and log training progress

## 🚀 Quick Start

### 1. Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your credentials
OPENAI_API_KEY=your-openai-api-key-here
FINE_TUNED_MODEL=your-current-model-id
MODEL_ID=gpt-3.5-turbo  # Base model for new training
```

### 2. Install Dependencies

```bash
# Install OpenAI CLI
pip3 install --user openai

# Install jq for JSON parsing (recommended)
sudo apt-get install jq
```

### 3. Prepare Training Data

```bash
# Create training data directory
mkdir -p data

# Add your .jsonl training files to data/
# Example: data/new_training_batch.jsonl
```

### 4. Run the Pipeline

```bash
# 1. Upload training data
./upload_jsonl.sh new_training_batch.jsonl

# 2. Start fine-tuning (uses latest uploaded file)
./continue_finetune.sh

# 3. Monitor progress
./track_job.sh --follow
```

## 📋 Detailed Usage

### Upload Training Data

```bash
# Upload specific file
./upload_jsonl.sh training_data.jsonl

# Upload with full path
./upload_jsonl.sh /path/to/training_data.jsonl

# List available files
./upload_jsonl.sh
```

**Features:**
- Validates JSONL format
- Extracts and saves file IDs
- Comprehensive logging
- Error handling and recovery

### Start Fine-Tuning

```bash
# Use latest uploaded file and default model
./continue_finetune.sh

# Use specific file ID
./continue_finetune.sh file-abc123def456

# Use specific model as base
./continue_finetune.sh gpt-3.5-turbo

# Use specific file and model
./continue_finetune.sh file-abc123def456 gpt-3.5-turbo
```

**Features:**
- Automatic file ID resolution
- Model inheritance from environment
- Job ID tracking
- Resume-friendly design

### Track Job Progress

```bash
# Check latest job status
./track_job.sh

# Check specific job
./track_job.sh ftjob-abc123def456

# Follow progress continuously
./track_job.sh --follow

# List all recent jobs
./track_job.sh --list

# Show job history
./track_job.sh --history
```

**Features:**
- Real-time status monitoring
- Automatic model ID extraction
- Comprehensive job history
- Terminal state detection

## 📁 File Structure

```
├── data/                       # Training data (.jsonl files)
├── logs/                       # All pipeline logs and tracking
│   ├── upload_*.log           # Upload operation logs
│   ├── finetune_*.log         # Fine-tuning job logs
│   ├── tracking_*.log         # Job monitoring logs
│   ├── latest_file_id.txt     # Most recent uploaded file
│   ├── latest_job_id.txt      # Most recent fine-tuning job
│   ├── latest_completed_model.txt # Most recent completed model
│   ├── file_ids.txt           # All uploaded files history
│   ├── job_history.txt        # All fine-tuning jobs history
│   └── completed_models.txt   # All completed models history
├── upload_jsonl.sh            # Upload training data script
├── continue_finetune.sh       # Start fine-tuning script
├── track_job.sh               # Monitor progress script
└── .env                       # Environment configuration
```

## 🔧 Environment Variables

### Required
- `OPENAI_API_KEY` - Your OpenAI API key

### Optional
- `FINE_TUNED_MODEL` - Current production model ID
- `MODEL_ID` - Base model for new fine-tuning (default: gpt-3.5-turbo)

## 📝 Training Data Format

Training data should be in JSONL format with conversation examples:

```jsonl
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "Hello!"}, {"role": "assistant", "content": "Hi there! How can I help you today?"}]}
{"messages": [{"role": "system", "content": "You are a helpful assistant."}, {"role": "user", "content": "What's the weather?"}, {"role": "assistant", "content": "I don't have access to current weather data, but I can help you find weather information."}]}
```

## 🔄 Workflow Examples

### Basic Workflow
```bash
# 1. Add new training data
cp new_examples.jsonl data/

# 2. Upload and start training
./upload_jsonl.sh new_examples.jsonl
./continue_finetune.sh

# 3. Monitor until completion
./track_job.sh --follow
```

### Advanced Workflow
```bash
# 1. Upload multiple files
./upload_jsonl.sh batch1.jsonl
./upload_jsonl.sh batch2.jsonl

# 2. Use specific file for training
./continue_finetune.sh file-abc123 my-custom-model-v1

# 3. Track specific job
./track_job.sh ftjob-def456 --follow
```

### Resume After Interruption
```bash
# Check what was last uploaded
./upload_jsonl.sh

# Check last job status
./track_job.sh

# Continue monitoring if still running
./track_job.sh --follow
```

## 🛠️ Troubleshooting

### Common Issues

**1. API Key Not Found**
```bash
# Check .env file exists and has OPENAI_API_KEY
cat .env | grep OPENAI_API_KEY
```

**2. OpenAI CLI Not Available**
```bash
# Install OpenAI CLI
pip3 install --user openai

# Verify installation
python3 -m openai --help
```

**3. File Upload Failures**
```bash
# Check file format
head -n 1 data/training.jsonl | jq .

# Check file permissions
ls -la data/training.jsonl
```

**4. Job Not Starting**
```bash
# Verify file ID format
cat logs/latest_file_id.txt

# Check recent uploads
./track_job.sh --history
```

### Logging and Debugging

All operations are logged with timestamps:
- Upload logs: `logs/upload_*.log`
- Fine-tuning logs: `logs/finetune_*.log`
- Tracking logs: `logs/tracking_*.log`

Enable verbose debugging by checking log files:
```bash
# View latest logs
ls -lt logs/

# Follow real-time logs
tail -f logs/tracking_*.log
```

## 🔒 Security Best Practices

1. **Environment Variables**: Never commit `.env` files to version control
2. **API Keys**: Rotate OpenAI API keys regularly
3. **File Permissions**: Ensure scripts are executable only by owner
4. **Log Files**: Review logs for sensitive information before sharing

## 🚦 System Design Features

### Modularity
- Each script handles one specific phase
- Independent execution possible
- Shared state through log files

### Resumability
- All operations save progress to files
- Scripts can resume from last known state
- Error recovery and retry mechanisms

### Cleanliness
- Structured logging with timestamps
- Organized file hierarchy
- Self-contained operations

### Human Control
- Manual trigger only (no automation)
- Clear status reporting
- Interactive progress monitoring

## 📈 Best Practices

### Training Data
- Start with small batches (100-1000 examples)
- Validate data quality before upload
- Keep consistent format across batches

### Model Management
- Test new models before replacing production
- Keep track of model lineage
- Document training data sources

### Monitoring
- Use `--follow` for long-running jobs
- Check job history regularly
- Monitor for failed jobs

## 🤝 Support

For issues or questions:
1. Check log files in `logs/` directory
2. Verify environment configuration
3. Review troubleshooting section
4. Check OpenAI API status and documentation

---

This pipeline enables systematic, incremental improvement of OpenAI models through controlled fine-tuning workflows.