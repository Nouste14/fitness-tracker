#!/bin/bash
# Auto-bumps the SW cache version on every Netlify deploy.
# You never need to manually edit sw.js again.
set -e

TIMESTAMP=$(date +%s)
sed -i "s/const CACHE = 'nour-fitness-[^']*'/const CACHE = 'nour-fitness-$TIMESTAMP'/" sw.js
echo "✅ SW cache version → nour-fitness-$TIMESTAMP"
