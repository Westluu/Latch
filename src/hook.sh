#!/bin/bash
# Debug hook — just log stdin to a file
cat > /tmp/latch-hook-debug.json
echo "hook fired at $(date)" >> /tmp/latch-hook-debug.log
