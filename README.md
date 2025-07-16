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

## Development Notes

- No user registration, login, or session management
- All requests automatically use the hardcoded user
- Simplified codebase for easy maintenance
- Direct integration ready for ChatGPT and Codesphere environments
