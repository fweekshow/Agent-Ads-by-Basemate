import { createPublicClient, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { getNetwork } from "./walletSendCalls.js";

const IDENTITY_REGISTRY_MAINNET = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const IDENTITY_REGISTRY_SEPOLIA = "0x8004A818BFB912233c491871b3d84c89A494BD9e";

export async function isRegisteredAgent(walletAddress: string): Promise<boolean> {
  const network = getNetwork();
  const client = createPublicClient({
    chain: network === "base-mainnet" ? base : baseSepolia,
    transport: http(),
  });
  const balance = await client.readContract({
    address: (network === "base-mainnet" ? IDENTITY_REGISTRY_MAINNET : IDENTITY_REGISTRY_SEPOLIA) as `0x${string}`,
    abi: [{ inputs: [{ name: "owner", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }],
    functionName: "balanceOf",
    args: [walletAddress as `0x${string}`],
  });
  return balance > 0n;
}
