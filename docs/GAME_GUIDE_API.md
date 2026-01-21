# Game Guide API

The Game Guide API provides AI-powered strategic game guides for any game title using OpenAI's GPT-3.5-turbo model.

## Endpoint

```
POST /game-guide
```

## Request Format

```json
{
  "gameTitle": "string (required)",
  "notes": "string (optional)"
}
```

### Parameters

- **gameTitle** (required): The name of the game you want a guide for
- **notes** (optional): Additional context or specific areas to focus on

## Response Format

### Success Response

```json
{
  "success": true,
  "message": "Game guide generated successfully",
  "data": {
    "guide": "AI-generated strategic guide with bullet points",
    "gameTitle": "The provided game title",
    "model": "gpt-3.5-turbo",
    "timestamp": "2025-07-29T01:11:40.106Z"
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Error description",
  "timestamp": "2025-07-29T01:11:40.106Z",
  "details": "Detailed error information (if available)"
}
```

## Usage Examples

### Basic Request

```bash
curl -X POST http://localhost:8080/game-guide \
  -H "Content-Type: application/json" \
  -d '{
    "gameTitle": "Chess"
  }'
```

### Request with Notes

```bash
curl -X POST http://localhost:8080/game-guide \
  -H "Content-Type: application/json" \
  -d '{
    "gameTitle": "The Legend of Zelda: Breath of the Wild",
    "notes": "Focus on combat tips and resource management"
  }'
```

### JavaScript Example

```javascript
const axios = require('axios');

async function getGameGuide(gameTitle, notes) {
  try {
    const response = await axios.post('http://localhost:8080/game-guide', {
      gameTitle,
      notes
    });
    
    if (response.data.success) {
      console.log('Game Guide:', response.data.data.guide);
      return response.data.data;
    } else {
      console.error('Error:', response.data.error);
    }
  } catch (error) {
    console.error('Request failed:', error.message);
  }
}

// Usage
getGameGuide("Minecraft", "Focus on survival mode strategies");
```

### Using the Service Directly (Node.js)

```javascript
const { gameGuideService } = require('./dist/services/game-guide');

async function example() {
  const result = await gameGuideService.simulateGameGuide(
    "The Legend of Zelda: Breath of the Wild", 
    "Focus on combat tips"
  );
  
  if (result.error) {
    console.error('Error:', result.error);
  } else {
    console.log('Guide:', result.guide);
  }
}
```

## Guide Content Structure

The AI generates strategic guides that include:

- **Game genre and mechanics analysis**
- **Best early-game strategies**
- **Mid-game adaptations**
- **Endgame win conditions**
- **Common player mistakes**
- **Situational tactics**

Each recommendation includes reasoning and risk mitigation strategies.

## Error Codes

- **400**: Bad Request - Missing or invalid `gameTitle`
- **500**: Internal Server Error - OpenAI API issues or service errors

## Requirements

- Valid OpenAI API key configured in the environment
- Server running on the configured port (default: 8080)

## Configuration

The service uses GPT-3.5-turbo model specifically as requested in the implementation. The OpenAI API key should be configured in the environment variables or configuration files.

## Testing

Run the integration tests to verify functionality:

```bash
node test-game-guide-integration.js
```

This will test:
- Input validation
- Error handling
- Response format
- API endpoint accessibility