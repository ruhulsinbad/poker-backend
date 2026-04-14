# ♠ Royal Poker — Telegram Mini App

A full-featured Telegram poker mini app with TON blockchain integration,
NFT marketplace (GetGems), chips economy, referral system, and level progression.

---

## 🏗️ Architecture

```
poker-miniapp/
├── contracts/          # TON Smart Contract (Tact)
│   └── chips_nft.tact  # NFT collection with 20% royalty
├── backend/            # Node.js + Socket.io server
│   ├── src/
│   │   ├── server.js           # Main Express + Socket.io server
│   │   ├── game/
│   │   │   ├── PokerEngine.js  # Texas Hold'em game logic
│   │   │   ├── Deck.js         # Card deck
│   │   │   └── HandEvaluator.js# Hand ranking & odds
│   │   └── db/
│   │       └── schema.sql      # PostgreSQL schema
│   └── Dockerfile
├── frontend/           # React + Telegram Mini App SDK
│   └── src/
│       ├── App.jsx
│       ├── pages/
│       │   ├── Home.jsx        # Lobby & table selection
│       │   ├── Game.jsx        # Live poker table
│       │   ├── Tasks.jsx       # Earn chips via tasks
│       │   ├── pages.jsx       # Leaderboard, Profile, NFT, BottomNav
│       │   └── Admin.jsx       # Admin control panel
│       └── store/
│           └── useStore.js     # Zustand state management
├── docker-compose.yml  # Full stack deployment
└── nginx.conf          # Reverse proxy + SSL
```

---

## 🚀 Setup Guide

### Step 1 — Create Telegram Bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram
2. `/newbot` → choose a name and username
3. Save your `BOT_TOKEN`
4. `/newapp` → create Mini App, set URL to your Vercel frontend URL
5. Enable inline mode: `/setinline`

---

### Step 2 — Backend Setup (Hetzner VPS)

```bash
# 1. Buy Hetzner CX21 (~$5/month) at hetzner.com
# 2. SSH into your server

ssh root@your-server-ip

# 3. Install Docker
curl -fsSL https://get.docker.com | sh
apt install docker-compose-plugin -y

# 4. Clone your repo
git clone https://github.com/you/poker-miniapp.git
cd poker-miniapp

# 5. Set up environment
cp backend/.env.example backend/.env
nano backend/.env   # Fill in all values

# 6. Start everything
docker compose up -d

# 7. Get SSL certificate (free)
apt install certbot -y
certbot certonly --standalone -d your-domain.com

# 8. Restart nginx
docker compose restart nginx
```

---

### Step 3 — Frontend Deploy (Vercel)

```bash
# In your local machine
cd frontend

# Create .env.local
echo "VITE_API_URL=https://your-domain.com" > .env.local
echo "VITE_ADMIN_TELEGRAM_ID=your_telegram_id" >> .env.local
echo "VITE_GETGEMS_URL=https://getgems.io/collection/your_contract" >> .env.local

# Deploy to Vercel
npm install -g vercel
vercel --prod
```

---

### Step 4 — TON Smart Contract Deploy

```bash
# Install Tact compiler
npm install -g @tact-lang/compiler

# Compile
tact --config tact.config.json contracts/chips_nft.tact

# Deploy (using Blueprint or ton-core)
# Set your wallet as owner
# Set royaltyAddress = your TON wallet
# Set gameServer = your backend's TON wallet

# After deploy, save the collection address to:
# backend/.env → NFT_COLLECTION_ADDRESS
```

---

### Step 5 — GetGems Verified Collection

1. Go to [GetGems.io](https://getgems.io)
2. Connect your TON wallet (must be the collection owner)
3. Go to your collection URL
4. Apply for Verification badge
5. Add collection description, logo, banner
6. Users can now list their chips NFTs here

---

## 💰 Revenue Model

| Source | How | Your Cut |
|---|---|---|
| Pack Sales | User buys Premium Chips with TON | 100% |
| NFT Primary | Mint fee (gas cost) | ~0.05 TON per mint |
| NFT Secondary | GetGems royalty (auto) | 20% per sale |
| NFT Resells | Same royalty forever | 20% per resale |
| Ad Revenue | Reward ads in task bar | 100% |
| Tournament Rake | 5% of pot | 5% per hand |

---

## 📊 Level System

| Level | Unlock |
|---|---|
| 1-9 | Basic gameplay, task earning |
| 10 | Revenue sharing activated |
| 15 + 50 referrals | Influencer pool (5% allocation) |
| 30 | NFT Marketplace access (sell chips as NFT) |

---

## 🪙 Token Allocation

| Pool | Allocation | Condition |
|---|---|---|
| Early Access | 10% | Users during testnet period |
| Influencer Pool | 5% | Level 15+ with 50+ referrals |
| Team + Dev + Reserve | 85% | Vesting schedule |

---

## 🔑 Admin Panel

Access at `/admin` (only your Telegram ID can access).

Features:
- Create/disable tasks
- Manual chips adjustment
- Broadcast messages to all/filtered users
- User management

---

## 🧪 Testnet Mode

During testnet:
- Use TON testnet (`https://testnet.toncenter.com/api/v2/jsonRPC`)
- Faucet: `https://t.me/testgiver_ton_bot`
- All chips earned during testnet → Premium Chips conversion at mainnet launch
- Early access users get 10% token allocation guaranteed

---

## 📡 Tech Stack

| Layer | Tech |
|---|---|
| Frontend | React 18, Vite, Telegram Mini App SDK |
| State | Zustand |
| Realtime | Socket.io |
| Backend | Node.js, Express |
| Database | PostgreSQL (Supabase free / self-hosted) |
| Cache | Redis (Upstash free / self-hosted) |
| Blockchain | TON, Tact smart contract |
| NFT Market | GetGems |
| Wallet | TON Connect 2.0 |
| Hosting | Vercel (frontend) + Hetzner (backend) |
| CI/CD | Docker Compose |
| Proxy | Nginx + Let's Encrypt SSL |

---

## ⚡ Monthly Cost (100k users)

| Service | Cost |
|---|---|
| Hetzner CX21 VPS | ~$6/month |
| Vercel (frontend) | Free |
| Supabase DB | Free (up to 50k rows) |
| Upstash Redis | Free |
| Domain | ~$1/month |
| **Total** | **~$7/month** |

---

## 📞 Support

Built for [@YourChannel](https://t.me/yourchannel)
# poker-backend
