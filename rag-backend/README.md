# RAG Backend

A lightweight retrieval-augmented generation backend built with Node.js, Express, and PostgreSQL (pgvector).

## Features

- Ingest text and store OpenAI embeddings in PostgreSQL.
- Query stored chunks and generate responses using your fine-tuned OpenAI model.
- Health check endpoint for Railway compatibility.
- Production-ready SSL configuration for PostgreSQL on Railway.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and fill in your credentials (API key, database URL, and `OPENAI_MODEL` for your fine-tuned model).
3. Run the schema against your PostgreSQL database:
   ```bash
   psql $DATABASE_URL -f schema.sql
   ```
4. Start the server:
   ```bash
   npm start
   ```

The server listens on `PORT` (default `3000`). Use `/api/ingest` to store text and `/api/query` to ask questions.
