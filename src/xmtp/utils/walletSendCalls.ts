import { validHex } from "@xmtp/agent-sdk";
import { toHex } from "viem";

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;

export type WalletSendCallsPayload = {
  version: string;
  chainId: `0x${string}`;
  from: `0x${string}`;
  calls: {
    to?: `0x${string}`;
    data?: `0x${string}`;
    value?: `0x${string}`;
    gas?: `0x${string}`;
    metadata?: {
      description: string;
      transactionType: string;
    } & Record<string, string>;
  }[];
  capabilities?: Record<string, string>;
};

/**
 * Create USDC transfer calls for EIP-5792 wallet_sendCalls.
 * Renders as a native payment card in Base app.
 */
export function createUSDCTransferCalls(
  network: "base-mainnet" | "base-sepolia",
  from: string,
  to: string,
  amountUSDC: number,
  description?: string
): WalletSendCallsPayload {
  const token = network === "base-mainnet" ? USDC_BASE : USDC_BASE_SEPOLIA;
  const chainId = network === "base-mainnet" ? 8453 : 84532;
  const amount = BigInt(Math.round(amountUSDC * 1_000_000)); // 6 decimals for USDC
  const data = `0xa9059cbb${to.slice(2).padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

  return {
    version: "1.0",
    from: validHex(from) as `0x${string}`,
    chainId: toHex(chainId) as `0x${string}`,
    calls: [
      {
        to: validHex(token) as `0x${string}`,
        data: validHex(data) as `0x${string}`,
        metadata: {
          description: description || `Transfer ${amountUSDC} USDC on ${network}`,
          transactionType: "erc20_transfer",
        },
      },
    ],
  };
}

export function getNetwork(): "base-mainnet" | "base-sepolia" {
  const env = process.env.BASE_NETWORK || process.env.XMTP_NETWORK || "base-sepolia";
  return env === "base-mainnet" ? "base-mainnet" : "base-sepolia";
}
