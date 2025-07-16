# Arcanos

AI operating system - Single User Edition

## Overview

Arcanos is a simplified AI operating system designed for single-user use. All functionality operates with a hardcoded user account for the repository owner.

## User Configuration

The system operates with a single hardcoded user:
- **ID**: `pbjustin`
- **Username**: `pbjustin`
- **Email**: `pbjustin@example.com`
- **Role**: `admin`

## Features

- **RAG (Retrieval Augmented Generation)**: Query and document management
- **HRC (Hallucination Resilient Core)**: Text validation and processing
- **Memory Storage**: Persistent memory management for conversations and context
- **Configuration Management**: System configuration and module management
- **Request Logging**: Activity tracking and analytics

## Quick Start

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Development mode**:
   ```bash
   npm run dev
   ```

3. **Production build**:
   ```bash
   npm run build
   npm start
   ```

## API Endpoints

- `GET /health` - Health check
- `GET /api/status` - System status
- `POST /api/ask` - Main AI query endpoint
- `GET /api/memory` - Retrieve memories
- `POST /api/memory` - Store new memory
- `GET /api/config` - Get configuration
- `POST /api/config` - Update configuration
- `GET /api/admin/stats` - System statistics

## Architecture

- **Express.js** server with TypeScript
- **Memory-based storage** (no external database required)
- **Modular design** with RAG, HRC, and configuration modules
- **No authentication** - simplified for single-user use

## OpenAI Integration

Arcanos includes full OpenAI API integration with support for:
- **Fine-tuned Models**: Your custom model `ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox`
- **Smart Fallback**: Falls back to `gpt-4-turbo` with interactive permission
- **Model Selection**: Toggle between fine-tuned and base models via `USE_FINE_TUNED` environment variable

### Environment Configuration
```bash
OPENAI_API_KEY=your_api_key_here
OPENAI_FINE_TUNE_MODEL=ft:gpt-3.5-turbo-0125:personal:arc_v1-1106:BpYtP0ox
USE_FINE_TUNED=true
```

## Custom GPT Integration

For complete instructions on integrating Arcanos with ChatGPT Custom GPTs and native applications, see:

📖 **[Custom GPT Integration Guide](./CUSTOM_GPT_INTEGRATION.md)**

This guide covers:
- Setting up Custom GPTs with Arcanos API
- Actions configuration for ChatGPT
- Native app integration examples
- Model management and fallback handling
- Troubleshooting and debugging

## Development Notes

- No user registration, login, or session management
- All requests automatically use the hardcoded user
- Simplified codebase for easy maintenance
- Direct integration ready for ChatGPT and Codesphere environments
