import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { Network } from "@x402/core/types";

import { logger } from "@/utils/logger.js";
import { getNetwork } from "@/xmtp/utils/walletSendCalls.js";

const BASEMATE_WALLET = "0xb257b5c180b7b2cb80e35d6079abe68d9cf0467f";

function getX402Network(): Network {
  return getNetwork() === "base-mainnet" ? "eip155:8453" : "eip155:84532";
}

export function startX402Server(): void {
  try {
    _startX402Server();
  } catch (err: any) {
    logger.error({ err }, "⚠️ x402 server failed to start — XMTP agent continues without HTTP API");
  }
}

function _startX402Server(): void {
  const PORT = parseInt(process.env.PORT || "3000", 10);
  const network = getX402Network();

  const facilitatorUrl =
    network === "eip155:8453"
      ? "https://api.cdp.coinbase.com/platform/v2/x402"
      : "https://x402.org/facilitator";

  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(network, new ExactEvmScheme());

  const app = express();
  app.use(express.json());

  const cphSetupPrice = process.env.CPH_SETUP_PRICE || "$1.00";

  const claimPriceLookup = async (context: { adapter: { getPath(): string } }) => {
    const path = context.adapter.getPath();
    const match = path.match(/\/api\/cph\/claim\/(\d+)/);
    if (!match) return "$0.50";
    const deliveryId = parseInt(match[1], 10);
    const { PendingCphDeliveryAdapter } = await import("@/discovery/adapters/cph.adapter.js");
    const delivery = await PendingCphDeliveryAdapter.getById(deliveryId);
    if (!delivery) return "$0.50";
    return `$${delivery.subscription.price_per_human.toFixed(2)}`;
  };

  app.use(
    paymentMiddleware(
      {
        "POST /api/cph/subscribe": {
          accepts: {
            scheme: "exact",
            price: cphSetupPrice,
            network,
            payTo: BASEMATE_WALLET,
          },
          description: "CPH subscription setup fee",
        },
        "POST /api/cph/claim/:deliveryId": {
          accepts: {
            scheme: "exact",
            price: claimPriceLookup,
            network,
            payTo: BASEMATE_WALLET,
          },
          description: "CPH per-human delivery payment",
        },
      },
      resourceServer,
    ),
  );

  app.post("/api/cph/subscribe", async (req, res) => {
    try {
      const { interests, xmtpGroupId, agentWallet } = req.body as {
        interests?: string[];
        xmtpGroupId?: string;
        agentWallet?: string;
      };

      if (!interests?.length || !xmtpGroupId || !agentWallet) {
        res.status(400).json({
          error: "Missing required fields: interests (string[]), xmtpGroupId (string), agentWallet (string)",
        });
        return;
      }

      const { isRegisteredAgent } = await import("@/xmtp/utils/erc8004.js");
      if (!(await isRegisteredAgent(agentWallet))) {
        res.status(403).json({
          error: "ERC-8004 identity required. Register at https://eips.ethereum.org/EIPS/eip-8004",
        });
        return;
      }

      const { CphSubscriptionAdapter } = await import("@/discovery/adapters/cph.adapter.js");
      const subscription = await CphSubscriptionAdapter.insert({
        agentInboxId: agentWallet,
        agentWallet,
        xmtpGroupId,
        interests,
        pricePerHuman: parseFloat(process.env.CPH_DEFAULT_PRICE || "0.50"),
      });

      res.json({
        subscriptionId: subscription.id,
        status: "active",
        interests: subscription.interests,
        xmtpGroupId: subscription.xmtp_group_id,
        pricePerHuman: subscription.price_per_human,
      });
    } catch (err: any) {
      logger.error({ err }, "x402 /api/cph/subscribe error");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/api/cph/claim/:deliveryId", async (req, res) => {
    try {
      const deliveryId = parseInt(req.params.deliveryId, 10);
      if (isNaN(deliveryId)) {
        res.status(400).json({ error: "Invalid delivery ID" });
        return;
      }

      const { PendingCphDeliveryAdapter } = await import("@/discovery/adapters/cph.adapter.js");
      const delivery = await PendingCphDeliveryAdapter.getById(deliveryId);
      if (!delivery) {
        res.status(404).json({ error: "Delivery not found" });
        return;
      }
      if (delivery.status !== "awaiting_payment") {
        res.status(409).json({ error: `Delivery is already ${delivery.status}` });
        return;
      }

      await PendingCphDeliveryAdapter.markPaid(deliveryId);
      logger.info(`💰 x402: delivery ${deliveryId} paid, will be fulfilled on next drain cycle`);

      res.json({
        deliveryId,
        status: "paid",
        message: "Payment received. Human will be added to your group shortly.",
        subscription: {
          interests: delivery.subscription.interests,
          xmtpGroupId: delivery.subscription.xmtp_group_id,
          pricePerHuman: delivery.subscription.price_per_human,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "x402 /api/cph/claim error");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/api/cph/status/:agentWallet", async (req, res) => {
    try {
      const { agentWallet } = req.params;
      const { CphSubscriptionAdapter } = await import("@/discovery/adapters/cph.adapter.js");
      const subs = await CphSubscriptionAdapter.getByAgentInbox(agentWallet);
      res.json({
        agentWallet,
        subscriptions: subs.map((s) => ({
          id: s.id,
          interests: s.interests,
          xmtpGroupId: s.xmtp_group_id,
          pricePerHuman: s.price_per_human,
          delivered: s.cph_delivered,
          active: s.active,
        })),
      });
    } catch (err: any) {
      logger.error({ err }, "x402 /api/cph/status error");
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "basemate-x402" });
  });

  app.listen(PORT, () => {
    logger.info(`🌐 x402 HTTP server listening on port ${PORT} (network: ${network}, facilitator: ${facilitatorUrl})`);
  });
}
