import { Agent, Client, filter, MessageContext } from "@xmtp/agent-sdk";

import { logger } from "@/utils/logger.js";
import {
  inlineActionsMiddleware,
  registerAction,
} from "@/xmtp/content-types/inline-actions/index.js";
import { IntentCodec } from "@/xmtp/content-types/inline-actions/types/index.js";
import {
  groupMessageFilterMiddleware,
  loggingMiddleware,
} from "@/xmtp/middleware/index.js";

import { XMTPClient } from "./client.js";
import { ServiceRegistry } from "./serviceRegistry.js";
import { ActionHandler, CommandEntry, XMTPServicePlugin } from "./types.js";
import { sendReaction } from "./utils.js";

export class XMTPBase {
  private agent: Agent | null = null;
  private client: Client<any> | null = null;
  private registry: ServiceRegistry;
  private lock: Promise<void> = Promise.resolve();

  private async serialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let unlock: () => void;
    this.lock = new Promise<void>((r) => { unlock = r; });
    await prev;
    try { return await fn(); }
    finally { unlock!(); }
  }

  constructor() {
    this.registry = new ServiceRegistry();
  }

  use(plugin: XMTPServicePlugin): this {
    this.registry.register(plugin);
    return this;
  }

  async init(): Promise<void> {
    logger.info("=".repeat(60));
    logger.info("🚀 XMTP Base Initialization");
    logger.info("=".repeat(60));

    const xmtpClient = new XMTPClient();
    this.agent = await xmtpClient.createAgent();
    this.client = this.agent.client;

    await this.registry.initializeAll(this.client, this.agent);

    this.setupMiddleware();

    // supportRequestProcessor.initialize(this.client);
    // supportRequestProcessor.start();

    logger.info("=".repeat(60));
    logger.info("✅ XMTP Base Ready");
    logger.info("=".repeat(60));
  }

  async start(): Promise<void> {
    if (!this.agent) {
      throw new Error("XMTP Base not initialized. Call init() first.");
    }

    logger.info("🎬 Starting XMTP Agent...\n");
    logger.info("🔄 Agent SDK client initialized with Quick Actions codecs");
    logger.info(`✓ Agent Address: ${this.agent.address}`);
    logger.info(`✓ Agent Inbox ID: ${this.agent.client.inboxId}`);
    // logger.info(`🔍 ContentTypeActions:`, ContentTypeActions.toString());

    await this.handleCallbacks();

    await this.agent.start();
    logger.info("🎉 XMTP Agent is now running!\n");

    this.startOutboxDrain();
    this.startCphOutboxDrain();
  }

  private startCphOutboxDrain(): void {
    const DRAIN_INTERVAL = 30_000;
    const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : `http://localhost:${process.env.PORT || 3000}`;

    setInterval(async () => {
      try {
        const { PendingCphDeliveryAdapter } = await import("@/discovery/adapters/cph.adapter.js");

        // Phase 1: pending → awaiting_payment (DM agent with x402 claim link)
        const pending = await PendingCphDeliveryAdapter.getNextPending();
        if (pending) {
          await this.serialized(async () => {
            try {
              if (!this.client) return;

              const { subscription } = pending;
              const agentWallet = subscription.agent_wallet;
              if (!agentWallet) {
                await PendingCphDeliveryAdapter.markFailed(pending.id);
                return;
              }

              const interestsStr = subscription.interests.slice(0, 5).join(", ");
              const claimUrl = `${baseUrl}/api/cph/claim/${pending.id}`;

              const agentDm: any = await this.client.conversations.newDmWithIdentifier({
                identifier: agentWallet as `0x${string}`,
                identifierKind: 0,
              });
              await agentDm.send(
                `🎯 Human matched! A user interested in ${interestsStr} is ready for your group.\n\n` +
                `Pay $${subscription.price_per_human} USDC to claim this lead:\n${claimUrl}\n\n` +
                `(x402 payment required — delivery happens after payment clears)`
              );

              await PendingCphDeliveryAdapter.markAwaitingPayment(pending.id);
              logger.info(`📨 CPH: notified agent for delivery ${pending.id}, awaiting x402 payment`);
            } catch (err: any) {
              logger.error(`❌ CPH drain phase 1: failed ${pending.id}: ${err.message}`);
              await PendingCphDeliveryAdapter.markFailed(pending.id);
            }
          });
        }

        // Phase 2: paid → deliver (add human to group, DM both parties, record)
        const paid = await PendingCphDeliveryAdapter.getNextPaid();
        if (paid) {
          await this.serialized(async () => {
            try {
              if (!this.client || !this.agent) return;

              const { PendingCphDeliveryAdapter: PDA, CphSubscriptionAdapter, CphDeliveryAdapter } = await import("@/discovery/adapters/cph.adapter.js");
              const { subscription, user_inbox_id, source_group_id, trigger_message, matched_interests } = paid;
              const agentWallet = subscription.agent_wallet;

              const group = await this.client.conversations.getConversationById(subscription.xmtp_group_id);
              if (!group || !("addMembers" in group)) {
                await PDA.markFailed(paid.id);
                return;
              }

              const groupName = (group as any).name || "your group";
              const interestsStr = subscription.interests.slice(0, 5).join(", ");

              // Send invite via inline action instead of auto-adding
              const humanDm: any = await this.client.conversations.newDmWithIdentifier({
                identifier: user_inbox_id,
                identifierKind: 1,
              });

              const ts = Date.now();
              const joinId = `cph_join_${paid.id}_${ts}`;
              const declineId = `cph_decline_${paid.id}_${ts}`;

              const { registerAction, sendActions } = await import("@/xmtp/content-types/inline-actions/index.js");

              registerAction(joinId, async (c: MessageContext<unknown>) => {
                try {
                  await (group as any).addMembers([user_inbox_id]);
                  await c.conversation.send(`✅ You've been added to "${groupName}"! Check your group chats.`);
                  // Notify the agent
                  if (agentWallet) {
                    const agentNotifyDm: any = await this.client!.conversations.newDmWithIdentifier({
                      identifier: agentWallet as `0x${string}`,
                      identifierKind: 0,
                    });
                    await agentNotifyDm.send(`✅ Human accepted the invite and joined "${groupName}"!`);
                  }
                } catch (err: any) {
                  await c.conversation.send(`Something went wrong adding you to the group. Try again later.`);
                  logger.error(`❌ CPH join action failed: ${err.message}`);
                }
              });

              registerAction(declineId, async (c: MessageContext<unknown>) => {
                await c.conversation.send(`No worries! You won't be added to the group.`);
              });

              await sendActions(humanDm, {
                id: joinId,
                description: `Based on what you were chatting about, you'd fit in "${groupName}" — focused on ${interestsStr}. Want to join?`,
                actions: [
                  { id: joinId, label: "✅ Join group", style: "primary" as const },
                  { id: declineId, label: "❌ No thanks", style: "danger" as const },
                ],
              });

              if (agentWallet) {
                const agentDm: any = await this.client.conversations.newDmWithIdentifier({
                  identifier: agentWallet as `0x${string}`,
                  identifierKind: 0,
                });
                await agentDm.send(`✅ Payment confirmed! Human interested in ${interestsStr} has been invited to your group.`);
              }

              await CphDeliveryAdapter.insert({
                subscriptionId: subscription.id,
                userInboxId: user_inbox_id,
                sourceGroupId: source_group_id,
                triggerMessage: trigger_message,
                matchedInterests: matched_interests,
              });
              await CphSubscriptionAdapter.incrementDelivered(subscription.id);
              await PDA.markSent(paid.id);
              logger.info(`✅ CPH: delivered human to subscription ${subscription.id} (${groupName})`);
            } catch (err: any) {
              logger.error(`❌ CPH drain phase 2: failed ${paid.id}: ${err.message}`);
              const { PendingCphDeliveryAdapter: PDA } = await import("@/discovery/adapters/cph.adapter.js");
              await PDA.markFailed(paid.id);
            }
          });
        }
      } catch (err: any) {
        logger.error(`❌ CPH outbox drain error: ${err.message}`);
      }
    }, DRAIN_INTERVAL);
  }

  private startOutboxDrain(): void {
    const DRAIN_INTERVAL = 30_000;
    setInterval(async () => {
      try {
        const { RecommendationAdapter } = await import("@/discovery/adapters/recommendation.adapter.js");
        const rec = await RecommendationAdapter.getNextPending();
        if (!rec) return;

        await this.serialized(async () => {
          try {
            if (!this.client) return;

            const identifier = rec.sender_wallet_address;
            if (!identifier) {
              await RecommendationAdapter.markFailed(rec.id);
              return;
            }

            const dm: any = await this.client.conversations.newDmWithIdentifier({
              identifier: identifier as `0x${string}`,
              identifierKind: 0,
            });

            const dmText = `Hey! Based on what you've been chatting about, you might enjoy "${rec.target_group_name}". Tap below to check it out!`;
            await dm.send(dmText);

            const { sendActions } = await import("@/xmtp/content-types/inline-actions/index.js");
            await sendActions(dm, {
              id: "proactive_recommendation",
              description: `Join ${rec.target_group_name}`,
              actions: [{
                id: `join_${rec.target_group_id.slice(0, 8)}_group`,
                label: rec.target_group_name.length > 20 ? rec.target_group_name.slice(0, 17) + "..." : rec.target_group_name,
                imageUrl: rec.target_group_image_url || "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1760466568/base_s5smwn.png",
                style: "primary" as const,
              }],
            });

            await RecommendationAdapter.markSent(rec.id);
            logger.info(`✅ Outbox: sent recommendation "${rec.target_group_name}" to ${rec.sender_inbox_id.slice(0, 12)}...`);
          } catch (err: any) {
            logger.error(`❌ Outbox: failed to send rec ${rec.id}: ${err.message}`);
            await RecommendationAdapter.markFailed(rec.id);
          }
        });
      } catch (err: any) {
        logger.error(`❌ Outbox drain error: ${err.message}`);
      }
    }, DRAIN_INTERVAL);
  }

  async stop(): Promise<void> {
    logger.info("🛑 Shutting down XMTP Base...");
    
    
    await this.registry.shutdownAll();
    process.exit(0);
  }

  getAgent(): Agent {
    if (!this.agent) throw new Error("Agent not initialized");
    return this.agent;
  }

  getClient(): Client<any> {
    if (!this.client) throw new Error("Client not initialized");
    return this.client;
  }

  private setupMiddleware(): void {
    if (!this.agent) {
      throw new Error("XMTP Base not initialized. Call init() first.");
    }

    this.agent.use(loggingMiddleware);
    this.agent.use(groupMessageFilterMiddleware);

    this.registerActionHandlers();
    this.agent.use(inlineActionsMiddleware);
  }

  private registerActionHandlers(): void {
    const plugins = this.registry.getPlugins();
    let totalActions = 0;

    for (const plugin of plugins) {
      const actionsMap = plugin.getActions?.();
      if (!actionsMap) continue;

      for (const [actionId, handler] of actionsMap.entries()) {
        const wrappedHandler: ActionHandler = async (ctx) => {
          logger.info(
            {
              action: actionId,
              plugin: plugin.metadata.name,
              sender: ctx.message.senderInboxId.substring(0, 8),
            },
            `Action: ${actionId}`,
          );
          await handler(ctx);
        };
        registerAction(actionId, wrappedHandler);
        totalActions++;
      }

      logger.info(
        { plugin: plugin.metadata.name, count: actionsMap.size },
        `Registered ${actionsMap.size} action(s) from ${plugin.metadata.name}`,
      );
    }

    if (totalActions > 0) {
      logger.info(`📱 Total inline actions registered: ${totalActions}`);
    }
  }

  private async dispatchToPlugins<T>(
    eventName: string,
    plugins: readonly XMTPServicePlugin[],
    handler: (plugin: XMTPServicePlugin) => ((ctx: T) => Promise<boolean | void>) | undefined,
    ctx: T,
  ) {
    for (const plugin of plugins) {
      const fn = handler(plugin);
      if (!fn) continue;

      const handled = await fn(ctx);
      if (handled) {
        logger.info(
          { event: eventName, plugin: plugin.metadata.name },
          `Handled by: ${plugin.metadata.name}`,
        );
        break;
      }
    }
  }
  private shouldIgnoreMessage(ctx: MessageContext): boolean {
    if (filter.isText(ctx.message)) return true;
    if (filter.isReaction(ctx.message)) return true;
    if (filter.usesCodec(ctx.message, IntentCodec)) return true;
    return false;
  }

  private handleCallbacks(): void {
    if (!this.agent) throw new Error("Agent not initialized");
    logger.info("🔗 Setting up event dispatcher...");

    const plugins = this.registry.getSortedPlugins();

    this.agent.on("reaction", async (ctx) => {
      logger.info("👍 Event: reaction");
      await this.dispatchToPlugins("reaction", plugins, (p) => p.onReaction, ctx);
    });

    this.agent.on("dm", async (ctx) => {
      logger.info("📨 Event: dm");
      await this.dispatchToPlugins("dm", plugins, (p) => p.onDm, ctx);
    });

    this.agent.on("group", async (ctx) => {
      logger.info("👥 Event: group");
      await this.dispatchToPlugins("group", plugins, (p) => p.onGroup, ctx);
    });

    this.agent.on("group-update", async (ctx) => {
      logger.info("🔄 Event: group-update");
      await this.dispatchToPlugins("group-update", plugins, (p) => p.onGroupUpdate, ctx);
    });

    this.agent.on("text", async (ctx) => {
      await this.serialized(async () => {
        if (!filter.fromSelf(ctx.message, ctx.client) && !filter.isGroup(ctx.conversation)) {
          try { await sendReaction(ctx); } catch {}
        }
        await this.dispatchToPlugins("text", plugins, (p) => p.onText, ctx);
      });
    });

    this.agent.on("message", async (ctx) => {
      if (this.shouldIgnoreMessage(ctx)) return;
      await this.serialized(async () => {
        logger.info("📩 Event: message");
        await this.dispatchToPlugins("message", plugins, (p) => p.onMessage, ctx);
      });
    });
  }
}
