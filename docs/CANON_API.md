# Canon Folder Access API

## Overview
The Canon Folder Access API provides complete file-level access to canon data from the backend. This API enables listing, reading, and writing storyline canon files for the Backstage Booker system.

## Base Path
All canon endpoints are available under `/api/canon/`

## Endpoints

### List Canon Files
**GET** `/api/canon/files`

Returns an array of all available canon files in the canon directory.

**Response:**
```json
[
  "canon-data.json",
  "sample-storyline.txt"
]
```

### Read Canon File
**GET** `/api/canon/files/:name`

Reads and returns the content of a specific canon file.

**Parameters:**
- `name` (path parameter): The filename to read

**Response:**
```json
{
  "name": "sample-storyline.txt",
  "content": "ARCANOS CANON: Sample Storyline\n==============================\n..."
}
```

**Error Responses:**
- `404` - Canon file not found
- `400` - Invalid filename (security check failed)

### Write Canon File
**POST** `/api/canon/files/:name`

Creates or updates a canon file with the provided content.

**Parameters:**
- `name` (path parameter): The filename to write

**Request Body:**
```json
{
  "content": "File content goes here..."
}
```

**Response:**
```json
{
  "message": "Canon file saved"
}
```

**Error Responses:**
- `400` - Content is required
- `400` - Invalid filename (security check failed)
- `500` - Failed to write canon file

## Security Features

### Path Traversal Protection
All endpoints validate filenames to prevent directory traversal attacks. The following characters are rejected:
- `..` (parent directory)
- `/` (directory separator)
- `\` (Windows directory separator)

### File Location
Canon files are stored in: `/containers/backstage-booker/canon/` (relative to the project root)

## Usage Examples

### JavaScript/Node.js
```javascript
// List all canon files
const files = await fetch('/api/canon/files').then(r => r.json());

// Read a specific file
const fileData = await fetch('/api/canon/files/canon-data.json').then(r => r.json());
console.log(fileData.content);

// Write a new file
await fetch('/api/canon/files/new-storyline.txt', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'New storyline content...' })
});
```

### cURL Examples
```bash
# List files
curl http://localhost:8080/api/canon/files

# Read file
curl http://localhost:8080/api/canon/files/canon-data.json

# Write file
curl -X POST http://localhost:8080/api/canon/files/test.txt \
  -H "Content-Type: application/json" \
  -d '{"content": "Test content"}'
```

## Copilot Integration Usage

This API is designed for use with GitHub Copilot and AI assistants for:

- **Storyline Management**: Load, edit, and save wrestling storyline canon
- **External Editor Sync**: Synchronize canon with external editors (Notion, local JSON dumps)
- **Auto-save Logic**: Automatically save long-term feud logic or kayfabe-locked histories
- **Content Generation**: Generate and store AI-assisted storyline content

### Example Copilot Workflow
1. List available canon files to understand current storylines
2. Load existing canon data to maintain continuity
3. Generate new storyline content based on existing canon
4. Save updated canon files with new storylines or character development

## Error Handling

All endpoints return appropriate HTTP status codes:
- `200` - Success
- `400` - Bad Request (validation errors)
- `404` - Not Found (file doesn't exist)
- `500` - Internal Server Error

Error responses include descriptive error messages:
```json
{
  "error": "Canon file not found"
}
```

## Testing

Use the provided test script to verify functionality:
```bash
node test-canon-api.js
```

The test script validates:
- File listing functionality
- File reading and writing
- Error handling for nonexistent files
- Security validation against path traversal
- Content validation for write operations