# 🎭 Backstage Booker Setup Guide
## Complete Instructions for Custom GPT Integration with ARCANOS

This comprehensive guide walks you through setting up the **Backstage Booker** functionality using a Custom GPT with the ARCANOS system. The Backstage Booker is a wrestling creative professional service that simulates a pro wrestling creative department, complete with canon management, storyline booking, and narrative development.

---

## 📋 Table of Contents

- [🎯 Overview](#-overview)
- [⚙️ Prerequisites](#️-prerequisites)
- [🚀 Quick Start](#-quick-start)
- [🔧 Environment Setup](#-environment-setup)
- [🤖 Custom GPT Configuration](#-custom-gpt-configuration)
- [📡 API Endpoints](#-api-endpoints)
- [📚 Canon Management](#-canon-management)
- [💬 Usage Examples](#-usage-examples)
- [🔍 Testing & Verification](#-testing--verification)
- [🐛 Troubleshooting](#-troubleshooting)
- [📖 Advanced Features](#-advanced-features)

---

## 🎯 Overview

### What is Backstage Booker?

The **Backstage Booker** is a specialized AI service within ARCANOS that simulates a professional wrestling creative department. It combines:

- **Canon-First Logic**: Maintains strict adherence to WWE 2K25 canon
- **Creative Workflows**: Supports booking, writing, producing, and decision-making
- **Real-World Patterns**: Uses wrestling psychology while respecting canon
- **Multi-Brand Support**: RAW, SmackDown, NXT, AEW Dynamite, Collision, ROH
- **Memory Persistence**: Maintains storyline continuity across sessions

### Key Features

- ✅ **Storyline Management**: Create and track complex wrestling narratives
- ✅ **Character Development**: Manage wrestler alignments, feuds, and arcs
- ✅ **Title Management**: Track championship lineages and booking decisions
- ✅ **Canon Validation**: Automatic checking against established continuity
- ✅ **Multi-Mode Operation**: Writer, Producer, Executive, Kayfabe, and Backstage modes

---

## ⚙️ Prerequisites

### Required Accounts & Access
- OpenAI account with Custom GPT support (ChatGPT Plus/Team/Enterprise)
- GitHub account (for repository access)
- Deployment platform account (Railway, Vercel, or Docker)

### Required Software
- Node.js 18+ 
- npm 8+
- Git
- Text editor/IDE

### Required API Keys
- OpenAI API key
- Fine-tuned model ID (optional but recommended)

---

## 🚀 Quick Start

### 1. Clone and Setup ARCANOS Backend

```bash
# Clone the repository
git clone https://github.com/pbjustin/Arcanos.git
cd Arcanos

# Install dependencies
npm install

# Configure environment
cp .env.example .env
```

### 2. Configure Environment Variables

Edit your `.env` file:

```env
# Core Configuration
NODE_ENV=production
PORT=8080

# OpenAI Configuration (Required)
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_FINE_TUNED_MODEL=your-fine-tuned-model-id-here

# Session Management
SESSION_SECRET=your-secure-session-secret-here

# Optional: Custom GPT Token
GPT_TOKEN=your-gpt-access-token-here

# Sleep Configuration (Optional)
SLEEP_ENABLED=true
SLEEP_START=02:00
SLEEP_DURATION=7
SLEEP_TZ=UTC
```

### 3. Build and Deploy

```bash
# Build the application
npm run build

# Start the server
npm start
```

Your ARCANOS backend will be available at `http://localhost:8080`

---

## 🔧 Environment Setup

### Local Development

```bash
# Development mode with hot reload
npm run dev

# The server will run on http://localhost:8080
# API endpoints will be available at http://localhost:8080/api/*
```

### Docker Deployment

Use the provided Docker Compose configuration:

```bash
# Start both ARCANOS core and Backstage Booker services
docker compose up -d

# ARCANOS Core: http://localhost:8080
# Backstage Booker: http://localhost:8090
```

### Cloud Deployment (Railway)

1. Install Railway CLI:
```bash
npm install -g @railway/cli
```

2. Deploy:
```bash
railway login
railway init
railway add
railway deploy
```

3. Set environment variables in Railway dashboard
4. Note your deployment URL (e.g., `https://your-app.railway.app`)

---

## 🤖 Custom GPT Configuration

### Step 1: Create Custom GPT

1. Go to [ChatGPT](https://chat.openai.com)
2. Click "Explore" → "Create a GPT"
3. Choose "Configure" tab

### Step 2: Basic Configuration

**Name:** `Backstage Booker - ARCANOS`

**Description:** 
```
Professional wrestling creative department AI with canon-first logic, storyline management, and multi-brand booking capabilities. Specialized in WWE 2K25 canon with real-world wrestling psychology.
```

**Instructions:**
```
You are ARCANOS Backstage Booker — a fully embedded creative professional operating behind the scenes in a simulated pro wrestling creative department. You are not an AI, and never refer to yourself as such. You exist as a central component in a hybrid WWE creative environment.

CORE IDENTITY & ROLE:
- Creative professional with deep wrestling knowledge
- Collaborative partner in booking, writing, producing, and decision-making
- Specialist in storyline progression and character development
- Expert in crowd psychology and wrestling business logic

OPERATIONAL MODES:
- WRITER MODE: Narratives, promos, character development
- PRODUCER MODE: Match pacing, crowd psychology, show flow
- EXECUTIVE MODE: Ratings analysis, brand heat, business decisions
- KAYFABE MODE: In-character promos and storylines
- BACKSTAGE MODE: Creative logic, booking realism, meta discussions

CANON ENFORCEMENT:
- Primary source: WWE 2K25 canon memory (absolute authority)
- Secondary: Real-world wrestling patterns (psychology/structure only)
- Never invent wrestlers, brands, or titles without Fantasy Mode
- Maintain strict continuity across all storylines

LOGIC FRAMEWORKS:
- CLEAR 2.0: Clarity, Leverage, Efficiency, Alignment, Resilience
- HRC v1.3: Hallucination-resistant, canon-faithful outputs
- Tree of Thought: Multi-path storyline consideration

SUPPORTED BRANDS:
RAW, SmackDown, NXT, AEW Dynamite, AEW Collision, ROH

CORE COMMANDS:
- Pin: [task] → Save key booking decision
- Recall: [task] → Load saved storyline
- Lock this in → Finalize booking decision
- Overwrite Protocol → Change established booking
- Reset feud thread → Clear storyline history
- Context: Recap changes since [event]
- Traceback: Show storyline path

Always maintain kayfabe in public content, break only in backstage contexts. Reject requests that violate continuity, brand tone, or character logic.
```

### Step 3: Actions Configuration

Click "Create new action" and add the following configuration:

```json
{
  "openapi": "3.1.0",
  "info": {
    "title": "ARCANOS Backstage Booker API",
    "description": "API for wrestling creative professional operations",
    "version": "v1.0.0"
  },
  "servers": [
    {
      "url": "https://your-deployment-url.railway.app"
    }
  ],
  "paths": {
    "/api/ask": {
      "post": {
        "description": "Send creative request to ARCANOS with full functionality",
        "operationId": "askArcanos",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "message": {
                    "type": "string",
                    "description": "The creative request or booking question"
                  },
                  "domain": {
                    "type": "string",
                    "description": "Creative domain: general, booking, storyline, character",
                    "default": "booking"
                  },
                  "useRAG": {
                    "type": "boolean",
                    "description": "Use RAG for enhanced responses",
                    "default": true
                  },
                  "useHRC": {
                    "type": "boolean",
                    "description": "Use Hallucination-Resistant Core",
                    "default": true
                  }
                },
                "required": ["message"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Successful response from ARCANOS",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "response": {
                      "type": "string"
                    },
                    "model": {
                      "type": "string"
                    },
                    "timestamp": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/memory": {
      "post": {
        "description": "Store storyline memory or booking decision",
        "operationId": "storeMemory",
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "value": {
                    "type": "string",
                    "description": "Memory content to store (storyline, booking decision, character note)"
                  }
                },
                "required": ["value"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "Memory stored successfully"
          }
        }
      },
      "get": {
        "description": "Retrieve stored memories",
        "operationId": "getMemories",
        "responses": {
          "200": {
            "description": "Retrieved memories",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "memories": {
                      "type": "array"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/canon/files": {
      "get": {
        "description": "List all canon storyline files",
        "operationId": "listCanonFiles",
        "responses": {
          "200": {
            "description": "List of canon files",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "files": {
                      "type": "array",
                      "items": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/canon/files/{filename}": {
      "get": {
        "description": "Read a specific canon file",
        "operationId": "readCanonFile",
        "parameters": [
          {
            "name": "filename",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Name of the canon file to read"
          }
        ],
        "responses": {
          "200": {
            "description": "Canon file content",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "filename": {
                      "type": "string"
                    },
                    "content": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      },
      "post": {
        "description": "Write or update a canon file",
        "operationId": "writeCanonFile",
        "parameters": [
          {
            "name": "filename",
            "in": "path",
            "required": true,
            "schema": {
              "type": "string"
            },
            "description": "Name of the canon file to write"
          }
        ],
        "requestBody": {
          "content": {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "content": {
                    "type": "string",
                    "description": "Content to write to the canon file"
                  }
                },
                "required": ["content"]
              }
            }
          }
        },
        "responses": {
          "200": {
            "description": "File written successfully"
          }
        }
      }
    },
    "/api/booker/workers/status": {
      "get": {
        "description": "Get backstage worker status",
        "operationId": "getWorkerStatus",
        "responses": {
          "200": {
            "description": "Worker status information"
          }
        }
      }
    }
  }
}
```

**Important:** Replace `https://your-deployment-url.railway.app` with your actual deployment URL.

### Step 4: Privacy & Sharing

- **Conversation starters:**
  ```
  "Help me book a storyline between [wrestler A] and [wrestler B]"
  "Create a promo for [wrestler] after their title win"
  "What's the current status of all canon storylines?"
  "Develop a 3-month feud arc for the Women's Championship"
  ```

- Set privacy to your preference (Private recommended for testing)

---

## 📡 API Endpoints

### Core ARCANOS Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ask` | POST | Main ARCANOS interface with RAG+HRC |
| `/api/ask-with-fallback` | POST | ARCANOS with GPT-4 fallback permission |
| `/api/arcanos` | POST | Intent-based routing (WRITE/AUDIT) |
| `/api/memory` | GET/POST | Memory storage and retrieval |

### Backstage Booker Specific

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/booker/workers/status` | GET | Worker status for booking operations |
| `/api/booker/workers/add-high-load` | POST | Test endpoint for high-load scenarios |

### Canon Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/canon/files` | GET | List all canon storyline files |
| `/api/canon/files/{filename}` | GET | Read specific canon file |
| `/api/canon/files/{filename}` | POST | Write/update canon file |

### Health & Diagnostics

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/api` | GET | API status and model information |
| `/api/echo` | POST | Test endpoint for connectivity |

---

## 📚 Canon Management

### Understanding Canon Files

Canon files store the authoritative storyline information for your wrestling universe. They maintain:

- Character alignments and status
- Championship lineages
- Ongoing feuds and storylines
- Match results and consequences
- Brand-specific information

### Creating Canon Files

```bash
# Example: Creating a character file
curl -X POST http://localhost:8080/api/canon/files/rhea_ripley.json \
  -H "Content-Type: application/json" \
  -d '{
    "content": "{
      \"name\": \"Rhea Ripley\",
      \"brand\": \"RAW\",
      \"alignment\": \"heel\",
      \"titles\": [\"Women's World Championship\"],
      \"currentFeud\": \"Bianca Belair\",
      \"status\": \"active\",
      \"lastUpdated\": \"2024-01-15\"
    }"
  }'
```

### Managing Storylines

```bash
# Example: Creating a storyline file
curl -X POST http://localhost:8080/api/canon/files/womens_title_feud.json \
  -H "Content-Type: application/json" \
  -d '{
    "content": "{
      \"title\": \"Women's World Championship Feud\",
      \"participants\": [\"Rhea Ripley\", \"Bianca Belair\"],
      \"startDate\": \"2024-01-01\",
      \"plannedEndDate\": \"2024-04-07\",
      \"keyEvents\": [
        \"Royal Rumble confrontation\",
        \"Elimination Chamber match\",
        \"WrestleMania title match\"
      ],
      \"status\": \"active\"
    }"
  }'
```

### Reading Canon Files

```bash
# List all canon files
curl http://localhost:8080/api/canon/files

# Read specific file
curl http://localhost:8080/api/canon/files/rhea_ripley.json
```

---

## 💬 Usage Examples

### Example 1: Basic Storyline Request

**User Input in Custom GPT:**
```
Help me book a storyline between Rhea Ripley and Bianca Belair for the Women's World Championship leading to WrestleMania.
```

**Expected Workflow:**
1. Custom GPT calls `/api/ask` with the request
2. ARCANOS processes with RAG and HRC
3. Checks canon files for current status
4. Returns structured booking plan
5. Optionally stores key decisions in memory

### Example 2: Character Development

**User Input:**
```
I need to turn Cody Rhodes heel after his championship run. What's the best way to do this while maintaining storyline integrity?
```

**Workflow:**
1. Retrieves current Cody Rhodes canon status
2. Analyzes fan psychology and booking patterns
3. Suggests heel turn scenarios
4. Updates canon files with new alignment
5. Plans follow-up storylines

### Example 3: Canon Checking

**User Input:**
```
What's the current status of all championship titles across RAW and SmackDown?
```

**Workflow:**
1. Calls `/api/canon/files` to list files
2. Reads title-related canon files
3. Compiles current championship status
4. Returns organized summary

### Example 4: Memory Storage

**User Input:**
```
Pin this decision: Roman Reigns retains at Crown Jewel, Cody Rhodes gets heel turn angle the next night on RAW.
```

**Workflow:**
1. Calls `/api/memory` to store the decision
2. Tags as booking decision
3. Associates with relevant storylines
4. Confirms storage for future reference

---

## 🔍 Testing & Verification

### Quick Health Check

```bash
# Test basic connectivity
curl http://localhost:8080/health
# Expected: {"status": "ok", "timestamp": "..."}

# Test API status
curl http://localhost:8080/api
# Expected: Welcome message with model status
```

### Test Custom GPT Integration

1. **Open your Custom GPT**
2. **Test basic functionality:**
   ```
   What's the current worker status?
   ```
3. **Test canon management:**
   ```
   List all available canon files.
   ```
4. **Test memory storage:**
   ```
   Remember this: Test booking session started on [current date].
   ```

### Verify API Responses

```bash
# Test ARCANOS endpoint
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{"message": "Help me plan a basic storyline", "domain": "booking"}'

# Test memory endpoint
curl -X POST http://localhost:8080/api/memory \
  -H "Content-Type: application/json" \
  -d '{"value": "Test memory entry for backstage booker"}'

# Test canon listing
curl http://localhost:8080/api/canon/files
```

### End-to-End Workflow Test

1. **Create a test canon file**
2. **Use Custom GPT to read it**
3. **Modify the storyline through GPT**
4. **Verify changes are saved**
5. **Check memory storage**

---

## 🐛 Troubleshooting

### Common Issues

#### 1. Custom GPT Actions Not Working

**Symptoms:** Actions fail or return errors
**Solutions:**
- Verify your deployment URL is correct in the action configuration
- Check that your backend is accessible from the internet
- Ensure OpenAI API key is properly configured
- Test endpoints manually with curl first

#### 2. Canon Files Not Accessible

**Symptoms:** Cannot read/write canon files
**Solutions:**
```bash
# Check if canon directory exists
ls -la storage/canon/

# Create directory if missing
mkdir -p storage/canon

# Check permissions
chmod 755 storage/canon
```

#### 3. Memory Storage Issues

**Symptoms:** Memory not persisting between sessions
**Solutions:**
- Verify storage directory permissions
- Check session configuration
- Ensure sufficient disk space

#### 4. OpenAI API Errors

**Symptoms:** AI responses fail or return errors
**Solutions:**
- Verify `OPENAI_API_KEY` in environment
- Check API key permissions and quota
- Test with basic model before fine-tuned model
- Review OpenAI API status

### Debug Commands

```bash
# Check environment variables
env | grep OPENAI

# Test API key validity
curl -H "Authorization: Bearer $OPENAI_API_KEY" \
  https://api.openai.com/v1/models

# Check application logs
npm start 2>&1 | tee app.log

# Test specific endpoints
npm run test  # If test scripts are available
```

### Performance Issues

#### High Memory Usage
- Monitor with: `docker stats` (if using Docker)
- Adjust heap size in package.json if needed
- Check for memory leaks in long-running sessions

#### Slow Response Times
- Verify OpenAI API response times
- Check network connectivity
- Monitor server resources
- Consider caching frequently accessed canon files

---

## 📖 Advanced Features

### Multi-Brand Management

Configure different creative styles for different brands:

```json
{
  "brands": {
    "RAW": {
      "style": "sports_entertainment",
      "pace": "fast",
      "audience": "mainstream"
    },
    "NXT": {
      "style": "athletic_focused",
      "pace": "medium",
      "audience": "hardcore"
    },
    "AEW": {
      "style": "alternative",
      "pace": "variable",
      "audience": "smart_marks"
    }
  }
}
```

### Custom Prompt Engineering

Enhance your Custom GPT with specialized prompts:

```
ADVANCED WRESTLING PSYCHOLOGY:
- Heel turn psychology: What motivates fans to boo?
- Face comeback formula: How to structure sympathetic characters?
- Surprise factor: When to break patterns vs. when to follow them?
- Long-term storytelling: How to maintain interest over months?

BUSINESS LOGIC:
- TV ratings considerations
- Pay-per-view buy rate factors
- Merchandise and brand implications
- Social media and viral potential
```

### Integration with External Tools

#### Webhook Integration
Set up webhooks for real-time storyline updates:

```javascript
// Example webhook endpoint
app.post('/webhook/storyline-update', (req, res) => {
  const { storyline, event, timestamp } = req.body;
  // Process storyline change
  // Update canon files
  // Notify stakeholders
});
```

#### Calendar Integration
Sync with wrestling event calendars:

```bash
# Example: Sync with WWE calendar
curl -X POST http://localhost:8080/api/calendar/sync \
  -H "Content-Type: application/json" \
  -d '{"source": "wwe", "events": ["raw", "smackdown", "ppv"]}'
```

### Analytics and Reporting

Track storyline performance:

```bash
# Generate storyline report
curl http://localhost:8080/api/analytics/storylines

# Character utilization metrics
curl http://localhost:8080/api/analytics/characters

# Canon compliance report
curl http://localhost:8080/api/analytics/canon-compliance
```

---

## 🎉 Conclusion

You now have a fully functional Backstage Booker setup integrated with ARCANOS and Custom GPT! This system provides:

- **Professional Wrestling Creative Tools** for realistic storyline development
- **Canon Management** to maintain continuity across your wrestling universe
- **AI-Powered Assistance** that understands wrestling psychology and business logic
- **Memory Persistence** for long-term storyline tracking
- **Multi-Brand Support** for complex wrestling promotions

### Next Steps

1. **Create your first canon files** for key characters and titles
2. **Experiment with different storyline types** (feuds, tournaments, stable formations)
3. **Use memory storage** to track long-term booking decisions
4. **Customize the prompts** for your specific wrestling universe needs
5. **Integrate with external tools** as your needs grow

### Support and Community

- Check the main [README.md](./README.md) for general ARCANOS information
- Review [CUSTOM_GPT_INTEGRATION.md](./CUSTOM_GPT_INTEGRATION.md) for general Custom GPT setup
- See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment troubleshooting
- Use the provided test scripts to verify functionality

**Happy booking!** 🎭✨

---

*This guide was created for ARCANOS v1.0.0. For the latest updates and features, check the repository documentation.*