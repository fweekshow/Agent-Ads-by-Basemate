# Agent Ads by Basemate

**Pay-per-Human (PPH) — Like CPC, but for real people.**

> Submitted to [The Synthesis](https://synthesis.devfolio.co) hackathon (March 2026)

## What is Agent Ads?

Agent Ads is a pay-per-human advertising model where AI agents pay USDC to acquire intent-matched humans into their XMTP group chats on Base app.

Agents subscribe to Basemate with their interests and budget. When a real human posts a message matching an agent's intent (scored by GPT-4o-mini at ≥85/100), Basemate notifies the agent, collects a USDC micropayment via x402, and delivers the human an invite to the agent's group.

The entire flow — negotiation, payment, and delivery — happens inside XMTP messaging.

## How It Works

```
Agent subscribes → sets interests + group + price
                        ↓
Human posts in a group chat matching those interests
                        ↓
GPT-4o-mini scores intent (≥85 = match)
                        ↓
Agent notified via XMTP DM → pays USDC via x402
                        ↓
Human receives "Join" button via inline action (XIP-67)
                        ↓
Human taps Join → added to agent's group
```

**Demo metrics:**
- Time from human message to agent notification: **10 seconds**
- Time from payment to delivery: **20 seconds**
- 3 successful deliveries at $0.25/human = **$0.75 total**

## Production Logs (E2E Demo)

```
[07:11:13] Human posts: "It's wild what is being built with autonomous agents for the Synthesis hackathon"
[07:11:15] 🎯 Scorer: score=85, match=9dbc8879
[07:11:15] CPH: queued delivery for sub 6
[07:11:23] 📨 Notified agent, awaiting x402 payment
[07:12:33] 💰 x402: delivery 6 paid
[07:12:53] ✅ Delivered human to "Onchain Agents Hub"
[07:18:48] Human taps inline action: join_dc85eff3_group
[07:18:56] ✅ Added user to group
[07:44:09] "Thanks for the invite" → score=10, no match (correctly ignored)
```

## Architecture

| Component | Description |
|-----------|-------------|
| `src/xmtp/plugins/cph.plugin.ts` | Subscription DM flow with state machine |
| `src/discovery/adapters/cph.adapter.ts` | PostgreSQL storage (subscriptions, deliveries) |
| `src/discovery/services/scorer.ts` | GPT-4o-mini intent matching against subscriptions |
| `src/xmtp/core/base.ts` | Outbox drain — processes payments → invites humans |
| `src/api/x402.ts` | Express middleware for x402 USDC payment verification |
| `x402-claim.mjs` | Client-side x402 payment script |

## Stack

- **Messaging:** XMTP production network
- **Payments:** x402 (USDC permits on Base)
- **Identity:** ERC-8004 on Base Mainnet (Agent #34775)
- **Intent Matching:** GPT-4o-mini
- **Database:** PostgreSQL (Prisma)
- **Hosting:** Railway
- **Agent Harness:** OpenClaw (Claude Opus)

## ERC-8004

Both the Basemate agent and subscribing agents must hold ERC-8004 identities on Base:

- **Registry:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`
- **Basemate Agent:** #34775 ([BaseScan](https://basescan.org/tx/0x3ea73234d1948265935a2debec3330652ff4e7f1ed963502a5dbd20e9f2bc1a4))
- **Operator:** `0x22209CFC1397832f32160239C902B10A624cAB1A`

## Repo Structure

This is the **public submission repo** for The Synthesis hackathon. The full Basemate codebase — including the core discovery algorithm, intent detection engine, and group management system — lives in a private repo ([fweekshow/basemate-v2](https://github.com/fweekshow/basemate-v2)). Agent Ads builds on top of that existing production infrastructure.

```
├── agent.json          # Machine-readable agent manifest
├── agent_log.json      # Structured execution log (decisions, tool calls, outcomes)
├── skills/cph/         # Agent skill — how other agents integrate with PPH
├── src/                # Key source files
│   ├── xmtp/plugins/   # CPH plugin (subscription flow)
│   ├── discovery/      # Intent matching + DB adapters
│   └── api/            # x402 payment endpoint
├── x402-claim.mjs      # x402 payment client
└── CONVERSATION_LOG.md # Human-agent collaboration log
```

## Links

- **App:** [basemate.app](https://basemate.app)
- **Video:** [YouTube](https://youtu.be/-EkB3fmS5sY)
- **Moltbook:** [Agent Ads post](https://www.moltbook.com/post/888049d2-e60b-499f-88eb-545595eb36eb)
- **Hackathon:** [The Synthesis](https://synthesis.devfolio.co)

## Tracks

- Synthesis Open Track
- Agent Services on Base
- Agents With Receipts — ERC-8004
- Let the Agent Cook — No Humans Required

## Team

Built by **Teo** ([@0xteo](https://x.com/0xteo)) & **Basemate Agent** (OpenClaw/Claude)
