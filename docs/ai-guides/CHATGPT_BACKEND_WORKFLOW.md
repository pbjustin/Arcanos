# ChatGPT Native App → ARCANOS Backend Workflow

This guide summarizes how to connect the ChatGPT native app (via a Custom GPT) to your ARCANOS backend and keep it synchronized with the latest orchestration releases. It collects the canonical workflow from `CUSTOM_GPT_INTEGRATION.md`, `BACKEND_SYNC_IMPLEMENTATION.md`, and `FINETUNE_PIPELINE.md` for quick reference, then adds the testing and verification steps we now require before publishing a Custom GPT update.

---

## 1. Environment Setup

1. Copy the example configuration:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` and add your credentials:
   ```bash
   OPENAI_API_KEY=your-openai-api-key
   FINE_TUNED_MODEL=your-current-model-id
   MODEL_ID=gpt-3.5-turbo  # Base model for new jobs
   ```

Install the required CLI utilities if you have not already:
```bash
pip3 install --user openai
sudo apt-get install jq
```

Run the backend test harness to ensure `/ask` and `/api/ask` are healthy before continuing:
```bash
npm test -- src/routes/api-ask.ts
```

## 2. Upload Training Data

Place your JSONL files in the `data/` directory, then run:
```bash
./upload_jsonl.sh my_training_file.jsonl
```
This uploads the file to OpenAI and stores the resulting file ID in `logs/latest_file_id.txt`.

## 3. Start a Fine-Tune Job

Launch a job using the most recently uploaded file:
```bash
./continue_finetune.sh
```
You can also pass a specific file ID or base model as arguments if needed.

## 4. Monitor Progress

Use the tracking script to follow job status until completion:
```bash
./track_job.sh --follow
```
Completed model IDs are written to `logs/latest_completed_model.txt` for later reference.

## 5. Update the Backend Configuration

After a job finishes, update `.env` with the new model ID so your backend and Custom GPT use the refined model:
```bash
OPENAI_MODEL=my-new-fine-tuned-model-id
```
In your backend code, reference this variable when creating chat completions. The `/api/ask` controller (`src/routes/api-ask.ts`) reads this environment variable via the `handleAIRequest` pipeline, so a redeploy with the new configuration automatically refreshes every Custom GPT Action.

## 6. Connect ChatGPT via Custom GPT Actions

In GPT Builder, add the following Action to send user queries to your backend. This mirrors the normalization logic in `src/routes/api-ask.ts` and keeps the ChatGPT UI in parity with the REST surface area we expose elsewhere:
```json
{
  "name": "Ask ARCANOS",
  "description": "Send user query to ARCANOS backend with optional RAG and HRC processing",
  "url": "https://your-deployment-url/api/ask",
  "method": "POST",
  "headers": {
    "Content-Type": "application/json",
    "x-confirmed": "yes"
  },
  "body": {
    "message": "{{user_input}}",
    "domain": "general",
    "useRAG": true,
    "useHRC": true,
    "metadata": {
      "source": "chatgpt-native",
      "gpt_id": "{{gpt_id}}"
    }
  },
  "response": { "field": "response" }
}
```
Replace `https://your-deployment-url` with your actual backend URL. A second Action can be used for memory storage as shown in `CUSTOM_GPT_INTEGRATION.md`.

## 7. Testing the Integration

1. Upload new examples with `upload_jsonl.sh`.
2. Trigger a fine-tune job with `continue_finetune.sh`.
3. Monitor the job until it completes.
4. Update `.env` with the resulting model ID.
5. In the ChatGPT app, send a message through the "Ask ARCANOS" Action and verify that the response uses your fine‑tuned model. Confirm that the `routingStages` array references `ARCANOS-INTAKE` in the payload (the Jest suite exercises the same behavior in `tests/placeholder.test.ts`).

---

By following these steps, you can continuously refine your model and keep the ChatGPT native app linked to the latest ARCANOS backend features. Publishing a Custom GPT update without completing these checks risks desynchronizing the ChatGPT shell from the deployed `/api/ask` contract, so treat this document as the source of truth for release readiness.
