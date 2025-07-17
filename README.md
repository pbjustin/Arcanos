# Arcanos Backend

A minimal TypeScript + Express backend for the Arcanos project.

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Arcanos
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment configuration**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

## Running the Application

### Development Mode
```bash
npm run dev
```
This starts the server with hot reloading using tsx.

### Production Mode
```bash
npm run build
npm start
```

## API Endpoints

- `GET /health` - Health check endpoint
- `GET /api` - Welcome message
- `POST /api/echo` - Echo endpoint for testing

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)
- `OPENAI_API_KEY` - Your OpenAI API key
- `FINE_TUNED_MODEL` - Your fine-tuned model name

## Project Structure

```
/src/index.ts         # Main server file
/src/routes/index.ts  # API routes
package.json          # Dependencies and scripts
tsconfig.json         # TypeScript configuration
.gitignore           # Git ignore rules
.env.example         # Environment variables template
README.md            # This file
```
