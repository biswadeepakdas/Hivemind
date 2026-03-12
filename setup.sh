#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  Hivemind SESI — One-click setup & GitHub push
# ═══════════════════════════════════════════════════════════════

set -e

echo "🧠 Hivemind SESI Setup"
echo "======================"

# 1. Initialize git
if [ ! -d ".git" ]; then
  echo "📦 Initializing git repository..."
  git init
  git add -A
  git commit -m "Initial commit: Hivemind SESI v2.0.0

- SESI Algorithm (Stigmergic Epistemic Swarm Intelligence)
- 9 specialized AI agents with Bayesian trust model
- Entropic task decomposition across 7 knowledge domains
- Pheromone-based indirect communication trails
- Real-time WebSocket streaming with embedded UI
- Legacy Hivemind v1 preserved for benchmarking
- Performance benchmark suite (benchmark.js)
- React visual demo (agent-swarm.jsx)
- Docker support for deployment"
  echo "✅ Git initialized and initial commit created"
else
  echo "⚠️  Git already initialized"
fi

# 2. Create GitHub repo (requires gh CLI: brew install gh)
echo ""
echo "📡 Creating GitHub repository..."
if command -v gh &> /dev/null; then
  gh repo create Hivemind --public --source=. --push --description "SESI: Stigmergic Epistemic Swarm Intelligence — A novel multi-agent AI orchestration algorithm"
  echo "✅ Pushed to GitHub!"
else
  echo "⚠️  GitHub CLI not found. Install it with: brew install gh"
  echo "   Then run: gh auth login"
  echo "   Then run: gh repo create Hivemind --public --source=. --push"
  echo ""
  echo "   Or push manually:"
  echo "   git remote add origin https://github.com/YOUR_USERNAME/Hivemind.git"
  echo "   git branch -M main"
  echo "   git push -u origin main"
fi

# 3. Install dependencies
echo ""
echo "📥 Installing dependencies..."
npm install

echo ""
echo "═══════════════════════════════════════════"
echo "✅ Setup complete!"
echo ""
echo "Quick start:"
echo "  1. Copy .env.example to .env and add your Anthropic API key"
echo "  2. npm start          — Run SESI server"
echo "  3. npm run benchmark  — Run performance comparison"
echo "  4. npm run legacy     — Run legacy server (port 3001)"
echo "═══════════════════════════════════════════"
