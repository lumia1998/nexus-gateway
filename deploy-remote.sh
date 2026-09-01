#!/bin/bash
# Deploy script for nexus-gateway to remote server

REMOTE_HOST="10.1.2.40"
REMOTE_USER="lumia"
REMOTE_DIR="/home/lumia/nexus-gateway"

echo "=== Nexus Gateway Remote Deployment ==="
echo "Target: $REMOTE_USER@$REMOTE_HOST:$REMOTE_DIR"
echo ""

# Build locally first
echo "Step 1: Building project locally..."
npm run build
if [ $? -ne 0 ]; then
    echo "Build failed!"
    exit 1
fi

echo ""
echo "Step 2: Creating deployment package..."
# Create a tar.gz with necessary files
tar -czf nexus-gateway-deploy.tar.gz \
    dist/ \
    package.json \
    package-lock.json \
    README.md \
    LICENSE \
    nexus-agentd.example.json

echo ""
echo "Step 3: Copying to remote server..."
echo "Please enter password when prompted (password: lumia)"
scp nexus-gateway-deploy.tar.gz $REMOTE_USER@$REMOTE_HOST:/tmp/

echo ""
echo "Step 4: Installing on remote server..."
ssh $REMOTE_USER@$REMOTE_HOST << 'ENDSSH'
    set -e

    echo "Creating directory..."
    mkdir -p ~/nexus-gateway
    cd ~/nexus-gateway

    echo "Extracting files..."
    tar -xzf /tmp/nexus-gateway-deploy.tar.gz

    echo "Installing dependencies..."
    npm install --production

    echo "Cleaning up..."
    rm /tmp/nexus-gateway-deploy.tar.gz

    echo ""
    echo "=== Installation Complete ==="
    echo "To start the gateway, run:"
    echo "  cd ~/nexus-gateway"
    echo "  node dist/cli.js"
    echo ""
    echo "The WebUI will be available at:"
    echo "  http://10.1.2.40:8787/"
ENDSSH

echo ""
echo "Cleaning up local deployment package..."
rm nexus-gateway-deploy.tar.gz

echo ""
echo "=== Deployment Complete ==="
