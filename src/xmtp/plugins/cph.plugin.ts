import { filter, MessageContext } from "@xmtp/agent-sdk";

import {
  sendActions,
  registerAction,
  type ActionHandler,
} from "@/xmtp/content-types/inline-actions/index.js";
import {
  XMTPServicePlugin,
  resolveSenderWalletAddress,
  type PluginMetadata,
  type EventResult,
} from "@/xmtp/core/index.js";
import { logger } from "@/utils/logger.js";
import type { CphConversationState, SubscriptionStep } from "@/discovery/adapters/cph.adapter.js";

const SUBSCRIPTION_TRIGGERS = ["subscribe", "buy humans", "cph", "lead subscribe"];
const CONFIRM_TRIGGERS = ["yes", "confirm", "y"];
const PPH_CACHE_TTL = 30_000;
let cphSubsCache: { subs: any[]; ts: number } = { subs: [], ts: 0 };

export class PPHPlugin extends XMTPServicePlugin {
  metadata: PluginMetadata = {
    name: "PPHPlugin",
    version: "1.0.0",
    priority: 50,
    description: "Cost Per Human — intent-matched lead delivery for agents",
  };

  constructor() {
    super();
    this.onText = this.onText.bind(this);
  }

  async onInit(): Promise<void> {
    const {
      CphConversationStateAdapter,
      CphSubscriptionAdapter,
      CphDeliveryAdapter,
      PendingCphDeliveryAdapter,
    } = await import("@/discovery/adapters/cph.adapter.js");
    await CphConversationStateAdapter.createTable();
    await CphSubscriptionAdapter.createTable();
    await CphDeliveryAdapter.createTable();
    await PendingCphDeliveryAdapter.createTable();
    logger.info("✅ PPHPlugin initialized");
  }

  getActions(): Map<string, ActionHandler> {
    const actions = new Map<string, ActionHandler>();
    actions.set("cph_dashboard", async (ctx) => {
      await this.showDashboard(ctx);
    });
    return actions;
  }

  private async showDashboard(ctx: MessageContext<unknown>): Promise<void> {
    const senderInboxId = ctx.message.senderInboxId;
    const { CphSubscriptionAdapter } = await import("@/discovery/adapters/cph.adapter.js");
    const subs = await CphSubscriptionAdapter.getByAgentInbox(senderInboxId);
    if (subs.length === 0) {
      await ctx.conversation.send("No active PPH subscriptions. Say \"subscribe\" to add one.");
      return;
    }
    const lines = subs.map((s) =>
      `• ${s.interests.join(", ")} → group ${s.xmtp_group_id.slice(0, 8)}... | ${s.cph_delivered} delivered | $${s.price_per_human}/human`
    );
    const total = subs.reduce((a, s) => a + s.cph_delivered * s.price_per_human, 0);
    await ctx.conversation.send(
      `Your PPH subscriptions:\n${lines.join("\n")}\n\nTotal USDC to pay: ~$${total.toFixed(2)}`
    );
  }

  /**
   * Shared confirmation logic used by both the inline action handler and the
   * "yes" text handler. Re-checks ERC-8004 identity before inserting.
   */
  private async executeConfirmation(
    senderInboxId: string,
    state: CphConversationState,
    conversation: MessageContext<unknown>["conversation"],
    wallet: string | null,
  ): Promise<void> {
    const { CphConversationStateAdapter, CphSubscriptionAdapter } = await import("@/discovery/adapters/cph.adapter.js");

    if (!state.interests || !state.group_id || state.price == null) {
      await CphConversationStateAdapter.delete(senderInboxId);
      await conversation.send("Session expired. Say \"subscribe\" to start over.");
      return;
    }

    const resolvedWallet = wallet || state.sender_wallet;
    if (resolvedWallet) {
      const { isRegisteredAgent } = await import("@/xmtp/utils/erc8004.js");
      if (!(await isRegisteredAgent(resolvedWallet))) {
        await CphConversationStateAdapter.delete(senderInboxId);
        await conversation.send(
          "Your ERC-8004 agent identity is no longer valid. Re-register at https://eips.ethereum.org/EIPS/eip-8004 and try again."
        );
        return;
      }
    }

    await CphSubscriptionAdapter.insert({
      agentInboxId: senderInboxId,
      agentWallet: resolvedWallet,
      xmtpGroupId: state.group_id,
      interests: state.interests,
      pricePerHuman: state.price,
    });
    await CphConversationStateAdapter.delete(senderInboxId);
    cphSubsCache = { subs: [], ts: 0 };
    await conversation.send("✅ Subscribed! I'll match humans and add them to your group. Say \"status\" for dashboard.");
  }

  async onText(ctx: MessageContext<string>): Promise<EventResult> {
    const content = (ctx.message.content || "").trim().toLowerCase();
    const senderInboxId = ctx.message.senderInboxId;
    const isGroup = filter.isGroup(ctx.conversation);

    if (isGroup) {
      this.fireAndForgetMatch(ctx);
      return undefined;
    }

    const { CphConversationStateAdapter } = await import("@/discovery/adapters/cph.adapter.js");

    // Start a new subscription flow
    if (SUBSCRIPTION_TRIGGERS.some((t) => content.includes(t)) && !(await CphConversationStateAdapter.exists(senderInboxId))) {
      const wallet = await resolveSenderWalletAddress(ctx as any);
      if (!wallet) {
        await ctx.conversation.send("I couldn't resolve your wallet address. Please try again.");
        return true;
      }
      const { isRegisteredAgent } = await import("@/xmtp/utils/erc8004.js");
      if (!(await isRegisteredAgent(wallet))) {
        await ctx.conversation.send(
          "PPH subscriptions are for registered agents only. Register your agent identity at https://eips.ethereum.org/EIPS/eip-8004"
        );
        return true;
      }
      await CphConversationStateAdapter.upsert(senderInboxId, { step: "interests", senderWallet: wallet });
      await ctx.conversation.send("What interests/topics should I match? (e.g. DeFi, trading, yield)");
      return true;
    }

    const state = await CphConversationStateAdapter.get(senderInboxId);
    if (state) {
      if (content === "cancel" || content === "no") {
        await CphConversationStateAdapter.delete(senderInboxId);
        await ctx.conversation.send("Cancelled.");
        return true;
      }

      if (state.step === "interests") {
        const interests = content.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        if (interests.length === 0) {
          await ctx.conversation.send("Please list at least one interest (e.g. DeFi, trading).");
          return true;
        }
        await CphConversationStateAdapter.upsert(senderInboxId, { step: "groupId", interests });
        await ctx.conversation.send("Send me the XMTP group ID where I should add matched humans.");
        return true;
      }

      if (state.step === "groupId") {
        const groupId = content.trim();
        if (!groupId || groupId.length < 8) {
          await ctx.conversation.send("Please paste a valid XMTP group ID.");
          return true;
        }
        await CphConversationStateAdapter.upsert(senderInboxId, { step: "price", groupId });
        await ctx.conversation.send("What's your budget per human in USDC? (e.g. 0.50)");
        return true;
      }

      if (state.step === "price") {
        const price = parseFloat(content.replace(/[^0-9.]/g, ""));
        if (isNaN(price) || price <= 0 || price > 1000) {
          await ctx.conversation.send("Please enter a valid USDC amount (e.g. 0.50).");
          return true;
        }
        await CphConversationStateAdapter.upsert(senderInboxId, { step: "confirm", price });

        // Re-read full state for the confirmation message
        const fullState = await CphConversationStateAdapter.get(senderInboxId);
        const interestsLabel = fullState?.interests?.join(", ") ?? "?";
        const groupLabel = (fullState?.group_id ?? "?").slice(0, 12);

        const ts = Date.now();
        const confirmId = `cph_confirm_${ts}`;
        const cancelId = `cph_cancel_${ts}`;

        registerAction(confirmId, async (c: MessageContext<unknown>) => {
          const sender = c.message.senderInboxId;
          const s = await CphConversationStateAdapter.get(sender);
          if (!s) {
            await c.conversation.send("Session expired. Say \"subscribe\" to start over.");
            return;
          }
          const w = await resolveSenderWalletAddress(c as any);
          await this.executeConfirmation(sender, s, c.conversation, w);
        });

        registerAction(cancelId, async (c: MessageContext<unknown>) => {
          await CphConversationStateAdapter.delete(c.message.senderInboxId);
          await c.conversation.send("Cancelled.");
        });

        await sendActions(ctx.conversation, {
          id: `cph_confirm_${ts}`,
          description: `Confirm: Match interests [${interestsLabel}], add to group ${groupLabel}..., $${price} USDC/human`,
          actions: [
            { id: confirmId, label: "✅ Confirm", style: "primary" as const },
            { id: cancelId, label: "❌ Cancel", style: "danger" as const },
          ],
        });
        return true;
      }

      // Text-based confirm — CLI agents can't tap inline buttons
      if (state.step === "confirm" && CONFIRM_TRIGGERS.includes(content)) {
        const wallet = await resolveSenderWalletAddress(ctx as any);
        await this.executeConfirmation(senderInboxId, state, ctx.conversation, wallet);
        return true;
      }
    }

    if (content === "status" || content === "dashboard") {
      await this.showDashboard(ctx);
      return true;
    }

    return undefined;
  }

  private fireAndForgetMatch(ctx: MessageContext<string>): void {
    import("@/discovery/adapters/index.js")
      .then(({ CphSubscriptionAdapter, CphDeliveryAdapter }) =>
        resolveSenderWalletAddress(ctx as any).then((wallet) => ({ CphSubscriptionAdapter, CphDeliveryAdapter, wallet }))
      )
      .then(async ({ CphSubscriptionAdapter, CphDeliveryAdapter, wallet }) => {
        const now = Date.now();
        let subs = cphSubsCache.subs;
        if (subs.length === 0 || now - cphSubsCache.ts > PPH_CACHE_TTL) {
          subs = await CphSubscriptionAdapter.getActive();
          cphSubsCache = { subs, ts: now };
        }
        if (subs.length === 0) return;

        const sourceGroupId = ctx.conversation.id;
        const messageContent = ctx.message.content || "";
        const senderInboxId = ctx.message.senderInboxId;

        const candidates = subs
          .filter((s) => s.xmtp_group_id !== sourceGroupId)
          .filter((s) => s.max_humans === 0 || s.cph_delivered < s.max_humans)
          .map((s) => ({
            id: s.id,
            xmtp_group_id: s.xmtp_group_id,
            interests: s.interests || [],
            agent_inbox_id: s.agent_inbox_id,
          }));

        if (candidates.length === 0) return;

        const { matchMessageToSubscriptions } = await import("@/discovery/services/scorer.js");
        const match = await matchMessageToSubscriptions({
          messageContent,
          subscriptions: candidates,
          sourceGroupId,
        });
        if (!match) return;

        const wasDelivered = await CphDeliveryAdapter.wasDelivered(match.subscriptionId, senderInboxId);
        if (wasDelivered) return;

        const { PendingCphDeliveryAdapter } = await import("@/discovery/adapters/cph.adapter.js");
        const sub = subs.find((s) => s.id === match.subscriptionId);
        if (!sub) return;

        await PendingCphDeliveryAdapter.insert({
          subscriptionId: match.subscriptionId,
          userInboxId: senderInboxId,
          userWalletAddress: wallet,
          sourceGroupId,
          triggerMessage: messageContent.slice(0, 500),
          matchedInterests: match.detected_interests,
        });
        logger.info(`🎯 PPH: queued delivery for sub ${match.subscriptionId} (score=${match.score})`);
      })
      .catch((err) => logger.error({ err }, "PPH match error"));
  }
}
