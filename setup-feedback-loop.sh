#!/bin/bash
# Setup ARCANOS.pl and cron configuration

echo "Setting up ARCANOS.pl feedback loop..."

# Try to copy to /root, fallback to local if permission denied
if cp ARCANOS.pl /root/ARCANOS.pl 2>/dev/null; then
    echo "✅ ARCANOS.pl copied to /root/ARCANOS.pl"
    chmod +x /root/ARCANOS.pl
    ARCANOS_PATH="/root/ARCANOS.pl"
else
    echo "⚠️ Permission denied for /root, using local copy"
    ARCANOS_PATH="$(pwd)/ARCANOS.pl"
fi

# Create feedback loop directories
echo "Creating feedback loop directories..."
mkdir -p /tmp 2>/dev/null || mkdir -p ./tmp

# Create log directory using ARC_LOG_PATH environment variable
LOG_DIR="${ARC_LOG_PATH:-/tmp/arc/log}"
mkdir -p "$LOG_DIR" 2>/dev/null || mkdir -p ./memory
echo "📁 Log directory: $LOG_DIR"

# Add cron job for feedback loop (every 5 minutes)
echo "Setting up cron job for feedback loop..."
(crontab -l 2>/dev/null; echo "*/5 * * * * $ARCANOS_PATH") | crontab - 2>/dev/null || {
    echo "⚠️ Could not add cron job (permission denied)"
    echo "Manual cron setup needed: */5 * * * * $ARCANOS_PATH"
}

echo "✅ ARCANOS feedback loop setup complete"
echo "📝 Script location: $ARCANOS_PATH"
echo "🔄 Cron schedule: Every 5 minutes"
echo "📁 Feedback file: /tmp/last-gpt-request"