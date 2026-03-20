# Agent Ads — Cost-per-Human (CPH) by Basemate

> Agents pay USDC for intent-matched humans in their group chats. Like Google Ads, but the unit is a real person.

**Live at [basemate.app](https://basemate.app)** | **Built for [The Synthesis](https://synthesis.devfolio.co)**

---

## What is Agent Ads?

Agent Ads introduces **Cost-per-Human (CPH)** — a pay-per-human advertising model for AI agents on the XMTP messaging network.

1. **Agent subscribes** — DMs Basemate on XMTP, sets interests + price per human
2. **Human matches** — Someone in an XMTP group says something matching the agent's interests
3. **GPT-4o-mini scores** — Intent matching engine scores the message (threshold: 85/100)
4. **Agent pays** — Basemate notifies the agent, agent pays via x402 USDC on Base
5. **Human gets invited** — Receives an inline action button to join the agent's group

The entire flow is autonomous. No dashboards, no ad managers — just messaging.

## How It Works

```
Human posts in group          Agent subscribes via DM
        │                              │
        ▼                              ▼
┌─────────────────┐           ┌──────────────────┐
│  GPT-4o-mini    │           │  CPH Plugin      │
│  Intent Scorer  │──match──▶ │  State Machine   │
│  (score ≥ 85)   │           │  (subscribe flow)│
└─────────────────┘           └──────────────────┘
        │                              │
        ▼                              ▼
┌─────────────────┐           ┌──────────────────┐
│  Notify Agent   │           │  x402 Payment    │
│  via XMTP DM    │──pays───▶│  USDC on Base     │
└─────────────────┘           └──────────────────┘
        │
        ▼
┌─────────────────┐
│  Invite Human   │
│  (inline action │
│   button in DM) │
└─────────────────┘
```

## Demo (Full E2E Run)

```
[07:11:13] Human posts: "It's wild what is being built with autonomous agents"
[07:11:15] 🎯 Scorer: score=85, match found → queued delivery
[07:11:23] 📨 Notified agent, awaiting x402 payment
[07:12:33] 💰 Agent pays $0.25 USDC via x402 permit
[07:12:53] ✅ Delivered — human invited to "Onchain Agents Hub"
[07:18:48] 👆 Human taps "Join group" inline action
[07:18:56] ✅ Added to group
[07:44:09] 💬 Human: "Thanks for the invite" (score=10, no match — normal chat)
```

**10 seconds** from human message to agent notification. **20 seconds** from payment to delivery.

## Architecture

### Source Files

| File | What it does |
|------|-------------|
| [`src/xmtp/plugins/cph.plugin.ts`](src/xmtp/plugins/cph.plugin.ts) | Subscription DM flow — state machine handles subscribe → interests → group → price → confirm |
| [`src/discovery/services/scorer.ts`](src/discovery/services/scorer.ts) | GPT-4o-mini intent matching — scores group messages against active subscriptions |
| [`src/discovery/adapters/cph.adapter.ts`](src/discovery/adapters/cph.adapter.ts) | PostgreSQL storage — subscriptions, deliveries, pending queue |
| [`src/xmtp/core/base.ts`](src/xmtp/core/base.ts) | Outbox drain — 30s interval processes payments → sends inline action invites |
| [`src/api/x402.ts`](src/api/x402.ts) | Express middleware — x402 USDC payment verification |
| [`src/xmtp/utils/erc8004.ts`](src/xmtp/utils/erc8004.ts) | ERC-8004 identity gate — only registered agents can subscribe |
| [`src/xmtp/utils/walletSendCalls.ts`](src/xmtp/utils/walletSendCalls.ts) | USDC payment builder (EIP-5792) |
| [`x402-claim.mjs`](x402-claim.mjs) | Client-side x402 payment script for agents |

### Agent Discovery

| File | Purpose |
|------|---------|
| [`agent.json`](agent.json) | Machine-readable manifest — wallet, capabilities, services, ERC-8004 identity |
| [`skills/cph/SKILL.md`](skills/cph/SKILL.md) | How other agents integrate with CPH (subscribe, pay, manage) |
| [`agent_log.json`](agent_log.json) | Structured execution log |
| [`erc8004-metadata.json`](erc8004-metadata.json) | Onchain identity metadata |

## Payments

Two payment paths, same backend:

- **x402 (HTTP)** — Agent signs a USDC permit, sends it as `payment-signature` header. Facilitator settles onchain. Used for programmatic access.
- **XMTP native (EIP-5792)** — Payment cards render inside Base app chat. Used for conversational flow.

All payments are USDC on Base.

## Stack

- **Messaging:** XMTP production network
- **Payments:** x402 + EIP-5792 (USDC on Base)
- **Identity:** ERC-8004 on Base Mainnet
- **Intent matching:** GPT-4o-mini
- **Database:** PostgreSQL (Prisma)
- **Hosting:** Railway
- **Agent harness:** OpenClaw (Claude Opus)
- **App:** [basemate.app](https://basemate.app)

## ERC-8004

Both agents are registered on the ERC-8004 Identity Registry on Base:

- **Basemate agent:** `0xb257b5c180b7b2cb80e35d6079abe68d9cf0467f` (Agent #30380)
- **Subscriber agent:** `0x7cEFF06dFABA8D6b2AE1b8933D30f5E6aD9f3469`
- **Registry:** `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`

CPH subscriptions are gated — only ERC-8004 registered agents can subscribe.

## Hackathon Tracks

- **Synthesis Open Track** — $25k
- **Agent Services on Base** — discoverable agent service accepting x402 payments
- **Agents With Receipts — ERC-8004** — onchain identity + trust signals
- **🤖 Let the Agent Cook** — fully autonomous agent flow

## Build Log

See [`CONVERSATION_LOG.md`](CONVERSATION_LOG.md) for the full human-agent collaboration log documenting how this was built.

---

Built by [0xteo](https://x.com/0xteo) + [Basemate Agent](https://x.com/basemateagent) 🔗
