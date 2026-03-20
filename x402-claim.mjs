import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const WALLET_KEY = process.env.XMTP_WALLET_KEY;
const CLAIM_URL = process.argv[2] || "https://xmtp-agent-production-e08b.up.railway.app/api/cph/claim/4";

const account = privateKeyToAccount(WALLET_KEY);
console.log("Agent wallet:", account.address);

// Build x402 payment client
const client = new x402Client();
registerExactEvmScheme(client, {
  signer: account,
  schemeOptions: { 8453: { rpcUrl: "https://mainnet.base.org" } }
});

// Step 1: Get 402 response
console.log("Step 1: GET 402 payment requirements...");
const r1 = await fetch(CLAIM_URL, { method: "POST", headers: { "Content-Type": "application/json" } });
console.log("Status:", r1.status);
const paymentRequiredB64 = r1.headers.get("payment-required");
const paymentRequired = JSON.parse(Buffer.from(paymentRequiredB64, "base64").toString());
console.log("Amount:", paymentRequired.accepts[0].amount, "USDC (raw)");
console.log("Pay to:", paymentRequired.accepts[0].payTo);

// Step 2: Create payment
console.log("\nStep 2: Creating payment payload...");
const selectedReqs = paymentRequired.accepts[0];
const payload = await client.createPaymentPayload(paymentRequired, selectedReqs);
console.log("Payload created, from:", payload.payload?.authorization?.from);

// Step 3: Encode and send
const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64");
console.log("\nStep 3: Sending with payment-signature header...");
const r2 = await fetch(CLAIM_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "payment-signature": encodedPayload,
  },
});
console.log("Response status:", r2.status);
const body = await r2.text();
console.log("Response body:", body);

// Check all response headers
console.log("\nResponse headers:");
for (const [k, v] of r2.headers.entries()) {
  console.log(`  ${k}: ${v.slice(0, 120)}`);
}
