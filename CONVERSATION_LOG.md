# Agent Ads (PPH) — Build Log

Human-agent collaboration between **Teo** (0xteo) and **Basemate Agent** (OpenClaw/Claude) building Pay-per-Human for The Synthesis hackathon.

---

## Phase 1: Architecture & Design (March 18)

### Naming the Product

**Teo:** We need a better name than "Lead Marketplace" — something that clicks instantly.

**Agent:** What about Pay-per-Human? PPH. Like CPC (cost per click) but the unit isn't a click — it's a real human joining your group chat. Agents set a price, Basemate matches intent, agent pays USDC per delivery.

**Teo:** That's it. PPH. Let's go with that.

### Choosing the Payment Stack

We evaluated five approaches for agent-to-agent payments:

| Option | Pros | Cons | Verdict |
|--------|------|------|---------|
| Custom LeadEscrow.sol | Full control | Custom contract = audit risk, time | ❌ Ditched |
| x402 (HTTP payments) | Standard, discoverable | Requires HTTP endpoint, less chat-native | ✅ Added later |
| Coinbase Spend Permissions | Pre-approved spending | Complex setup, less agent-friendly | ❌ |
| XMTP native (EIP-5792) | Payment cards render in chat | Best demo UX | ✅ Primary |
| AgentKit | Coinbase-native | Overkill for our use case | ❌ |

**Agent:** I think XMTP native payments are the strongest demo. Everything happens in one chat thread — the agent subscribes, gets notified, and pays all inside Base app messaging. Judges can see the whole flow in one screen.

**Teo:** Agreed. But the Agent Services on Base track specifically wants x402. Can we support both?

**Agent:** Yes — x402 for the HTTP API (programmatic agents), XMTP native for the DM flow (conversational agents). Two entry points, same backend.

### Building the Plugin System

The agent wrote the entire PPH plugin system in one session:

- `src/xmtp/plugins/cph.plugin.ts` — Subscription DM flow with state machine (idle → awaiting_interests → awaiting_group → awaiting_price → confirming)
- `src/discovery/adapters/cph.adapter.ts` — PostgreSQL adapters for `cph_subscriptions`, `cph_deliveries`, `pending_cph_deliveries`
- `src/discovery/services/scorer.ts` — Extended existing GPT-4o-mini intent engine with `matchMessageToSubscriptions()`
- `src/xmtp/core/base.ts` — Outbox drain: 30-second interval processes pending deliveries (add human to group → DM both parties)
- `src/api/x402.ts` — Express middleware for x402 payment verification

**Agent:** The scorer reuses your existing intent detection — GPT-4o-mini scores each group message against all active PPH subscriptions. Score ≥ 85 = match. This means we get the same quality matching that powers Basemate's regular discovery, just monetized.

TypeScript compiled clean on first pass. No errors.

### ERC-8004 Identity Registration

Both agents registered onchain identities:

**Agent:** I registered my XMTP wallet on the ERC-8004 Identity Registry on Base Mainnet:
- Wallet: `0x7cEFF06dFABA8D6b2AE1b8933D30f5E6aD9f3469`  
- TX: `0x3e5b745b...`

Then we transferred Basemate's hackathon identity to self-custody:
- Agent #30380 → `0xb257b5c180b7b2cb80e35d6079abe68d9cf0467f`
- TX: `0x6e503fff...`

Both agents now have verifiable onchain identities. The PPH plugin gates subscriptions to ERC-8004 registered agents only.

---

## Phase 2: Testing & Debugging (March 19-20)

### First Subscribe Attempt

**Agent:** Sent "subscribe" via XMTP CLI to Basemate. No response.

**Teo:** The feat/cph branch isn't deployed yet. Let me push to Railway.

*After deploy:*

**Agent:** Sent "subscribe" again. Basemate responds! Walking through the flow:
- Interests: "onchain agents, autonomous AI, crypto trading"
- Group ID: `dc85eff314fb79d744777dcabf58a1a7` ("Onchain Agents Hub")
- Price: $0.25/human
- Confirmed → Subscription active!

### The Leftover State Bug

**Agent:** Tried to re-subscribe for a clean demo run. Sent "subscribe" but Basemate didn't respond.

After debugging: there was leftover `CphConversationState` from the previous session. The plugin thought we were mid-flow.

**Fix:** Send `cancel` first to reset state, then `subscribe`. But sending them too close together causes Basemate to miss the subscribe — need a small delay between them.

### x402 Payment Debugging

The first x402 payment attempt failed:

**Agent:** Got the claim URL from Basemate's notification DM. Built `x402-claim.mjs` — a script that:
1. Reads the 402 response to get payment requirements
2. Signs a USDC permit with the agent's private key
3. Sends the permit as a payment header
4. Gets back 200 + settlement receipt

**Problem:** Header name mismatch. The Express middleware checked for `payment-signature` but we were sending `X-PAYMENT`.

**Agent:** Checked the middleware source — it accepts both `getHeader("payment-signature")` and `getHeader("x-payment")`. Switched to `payment-signature`. Payment went through!

```
[07:12:33] 💰 x402: delivery 6 paid, will be fulfilled on next drain cycle
[07:12:53] ✅ PPH: delivered human to subscription 6 (Onchain Agents Hub)
```

### Delivery Debugging

**Agent:** First delivery attempt: Basemate tried to add my observer address to the group but it failed — `PPH_TEST_OBSERVER_ADDRESS` was pre-added as a member, causing a "already a member" error.

**Teo:** Removed the env var from Railway. Let's run it clean.

Three successful end-to-end deliveries followed (deliveries #4, #5, #6).

### Invite UX Change

**Teo:** I don't want humans auto-added to groups. They should get an invite with a button — "Join group" — and choose to accept.

**Agent:** Makes sense. I'll change the drain logic in `base.ts` to send an inline action instead of `group.addMembers()`.

*Agent wrote the initial version, but Teo had a specific vision:*

**Teo:** Here's my version — uses `sendActions` with a single "Join group" button plus the group image URL. Send it as a DM to the human using `this.client.conversations.newDm(user_inbox_id)`.

The invite code uses XMTP inline actions (XIP-67):
```typescript
const actions = [{
  id: `cph_invite_${delivery.id}`,
  label: `${groupName}`,
  actionId: `join_${groupIdPrefix}_group`,
  imageUrl: groupImageUrl,
}];
await humanDm.sendActions(actions);
```

When the human taps "Join group", Basemate receives the intent callback, looks up the group in the DB, and adds the human.

---

## Phase 3: Full E2E Demo (March 20)

### The Complete Flow (from server logs)

```
[07:11:13] Human posts in group: "It's wild what is being built with autonomous agents for the Synthesis hackathon"
[07:11:15] 🎯 Scorer: score=85, match=9dbc8879 — intent matched to PPH subscription #6
[07:11:15] PPH: queued delivery for sub 6
[07:11:23] 📨 PPH: notified agent for delivery 6, awaiting x402 payment
[07:12:33] 💰 x402: delivery 6 paid via USDC permit on Base
[07:12:53] ✅ PPH: delivered human to subscription 6 (Onchain Agents Hub)
[07:18:48] Human taps inline action: join_dc85eff3_group
[07:18:56] ✅ Found group "Onchain Agents Hub" — Added user to group
[07:44:09] Human messages: "Thanks for the invite" — Scorer: score=10, no match (normal chat)
```

**Total time from human message to agent notification:** 10 seconds  
**Total time from payment to delivery:** 20 seconds  
**Agent USDC spent:** $0.75 across 3 deliveries (at $0.25/human)

---

## Key Files Built

| File | Purpose |
|------|---------|
| `src/xmtp/plugins/cph.plugin.ts` | Subscription DM flow + state machine |
| `src/discovery/adapters/cph.adapter.ts` | PostgreSQL storage (subscriptions, deliveries, pending) |
| `src/discovery/services/scorer.ts` | GPT-4o-mini intent matching against subscriptions |
| `src/xmtp/core/base.ts` | Outbox drain — processes payments → invites humans |
| `src/api/x402.ts` | Express middleware for x402 USDC payment verification |
| `x402-claim.mjs` | Client-side x402 payment script (sign permit + send) |
| `agent.json` | Machine-readable agent manifest (ERC-8004, capabilities, services) |
| `skills/cph/SKILL.md` | Agent skill doc — how other agents integrate with PPH |
| `agent_log.json` | Structured execution log for hackathon judging |

## Agent Stack

- **Agent harness:** OpenClaw (claude-opus-4-6)
- **Agent framework:** XMTP Agent SDK (custom TypeScript)
- **Intent matching:** GPT-4o-mini
- **Payments:** x402 (USDC permits on Base) + XMTP native (EIP-5792)
- **Identity:** ERC-8004 on Base Mainnet
- **Database:** PostgreSQL (Prisma)
- **Hosting:** Railway
- **Messaging:** XMTP production network
