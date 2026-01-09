#!/bin/bash
# Run tests against a temporary server instance

set -e

# Use a specific port to avoid conflicts with any running dev server
PORT=${TEST_PORT:-3456}

# Cleanup function
cleanup() {
  echo "Stopping server..."
  # Kill any process listening on our test port
  lsof -ti:$PORT | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Make sure port is free
lsof -ti:$PORT | xargs -r kill 2>/dev/null || true
sleep 0.5

# Start server in background
echo "Starting server on port $PORT..."
PORT=$PORT npm run dev > /dev/null 2>&1 &

# Wait for server to be ready
echo "Waiting for server..."
for i in {1..30}; do
  if curl -s http://localhost:$PORT/health > /dev/null 2>&1; then
    echo "Server ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "Server failed to start"
    exit 1
  fi
  sleep 0.2
done

# Run tests in remote mode
echo "Running tests in remote mode..."
TEST_MODE=remote TEST_REMOTE_URL=http://localhost:$PORT npm test
