import OpenAI from "openai";
import { RecommendationAdapter } from "@/discovery/adapters/recommendation.adapter.js";

const GROUPS_API = process.env.TRENDING_API_URL
  ? process.env.TRENDING_API_URL.replace("/trending", "/groups/all")
  : "https://devconnectarg-production.up.railway.app/api/groups/all";

const DEFAULT_IMAGE = "https://res.cloudinary.com/dg5qvbxjp/image/upload/v1760466568/base_s5smwn.png";
const SCORE_THRESHOLD = 75;
const MIN_MESSAGE_LENGTH = 8;

interface GroupCandidate {
  groupId: string;
  name: string;
  description: string;
  tags: string[];
  score: number;
  imageUrl: string;
}

interface ScorerResult {
  score: number;
  reasoning: string;
  detected_interests: string[];
  suggested_community_id: string | null;
}

interface ScoreMessageParams {
  messageContent: string;
  senderInboxId: string;
  senderWalletAddress: string | null;
  sourceGroupId: string;
}

/** CPH subscription candidate for intent matching */
export interface CphSubscriptionCandidate {
  id: number;
  xmtp_group_id: string;
  interests: string[];
  agent_inbox_id: string;
}

interface MatchSubscriptionsResult {
  subscriptionId: number;
  score: number;
  reasoning: string;
  detected_interests: string[];
}

let cachedGroups: GroupCandidate[] = [];
let lastCacheUpdate = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchSuggestableGroups(): Promise<GroupCandidate[]> {
  const now = Date.now();
  if (cachedGroups.length > 0 && now - lastCacheUpdate < CACHE_TTL) {
    return cachedGroups;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(GROUPS_API, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Groups API returned ${res.status}`);

    const data = await res.json() as any[];
    cachedGroups = data
      .filter((g: any) => g.isSuggestable)
      .map((g: any) => ({
        groupId: g.groupId,
        name: g.name,
        description: g.description || "",
        tags: Array.isArray(g.topics) ? g.topics : [],
        score: g.score || 0,
        imageUrl: g.imageUrl || DEFAULT_IMAGE,
      }))
      .sort((a, b) => b.score - a.score);

    lastCacheUpdate = now;
    return cachedGroups;
  } catch (err) {
    clearTimeout(timeout);
    console.error("❌ Scorer: failed to fetch groups:", err);
    return cachedGroups;
  }
}

function activityLabel(score: number): string {
  if (score > 10) return " (popular)";
  if (score > 0) return " (active)";
  return "";
}

function buildGroupList(groups: GroupCandidate[], sourceGroupId: string): string {
  return groups
    .filter((g) => g.groupId !== sourceGroupId)
    .map((g, i) => {
      const tags = g.tags.slice(0, 8).join(", ");
      const desc = g.description ? ` — ${g.description.slice(0, 80)}` : "";
      return `${i + 1}. [ID: ${g.groupId}] "${g.name}"${activityLabel(g.score)}${desc} [${tags}]`;
    })
    .join("\n");
}

const openai = (() => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey && apiKey !== "dummy" && apiKey.trim().length > 0) {
    return new OpenAI({ apiKey });
  }
  return null;
})();

export async function scoreMessage(params: ScoreMessageParams): Promise<void> {
  const { messageContent, senderInboxId, senderWalletAddress, sourceGroupId } = params;

  if (!openai) return;
  if (!messageContent || messageContent.length < MIN_MESSAGE_LENGTH) return;

  const groups = await fetchSuggestableGroups();
  if (groups.length === 0) return;

  const groupList = buildGroupList(groups, sourceGroupId);
  if (!groupList) return;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an intent scorer for a community discovery system. A user sent a message in a group chat. Your job is to detect when someone is genuinely engaged with a topic. They're just talking, and you're reading between the lines trying to understand and connect them with the right community.

Rate the message 0-100 based on how strongly it signals genuine interest in a topic:
- 90-100: Deep engagement — the person is actively working on, building, or problem-solving around a specific topic
- 75-89: Active interest — the person is discussing a topic with genuine curiosity, sharing opinions, or seeking input from others
- 50-74: Topical mention — a topic surfaces but the message is mostly conversational
- 25-49: Passing reference — a topic is barely touched, the message is primarily social
- 0-24: No topical signal — greetings, reactions, single words, off-topic chatter

Available communities (sorted by activity score):
${groupList}

Return ONLY valid JSON:
{"score": number, "reasoning": "brief explanation", "detected_interests": ["tag1", "tag2"], "suggested_community_id": "groupId or null"}

Rules:
- Match based on what the person is TALKING ABOUT, not whether they're asking for a group
- Someone discussing trading IS interested in a trading community, even if they never ask for one
- Someone building with AI agents IS interested in an AI community
- suggested_community_id must be one of the listed community IDs, or null
- Do NOT suggest the source community (ID: ${sourceGroupId})
- When multiple communities match, prefer higher-activity ones (listed first)
- Greetings, single-word messages, and pure social chat should always score under 30`,
        },
        { role: "user", content: messageContent },
      ],
      max_tokens: 150,
      temperature: 0.1,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return;

    let result: ScorerResult;
    try {
      const jsonStr = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
      result = JSON.parse(jsonStr);
    } catch {
      console.log(`🎯 Scorer: failed to parse LLM response: ${raw.slice(0, 100)}`);
      return;
    }

    console.log(`🎯 Scorer: "${messageContent.slice(0, 40)}..." → score=${result.score}, match=${result.suggested_community_id?.slice(0, 8) || "none"}`);

    if (result.score < SCORE_THRESHOLD || !result.suggested_community_id) return;

    const matchedGroup = groups.find((g) => g.groupId === result.suggested_community_id);
    if (!matchedGroup) return;

    const inserted = await RecommendationAdapter.insert({
      senderInboxId,
      senderWalletAddress,
      sourceGroupId,
      targetGroupId: matchedGroup.groupId,
      targetGroupName: matchedGroup.name,
      targetGroupImageUrl: matchedGroup.imageUrl,
      score: result.score,
      reasoning: result.reasoning,
      detectedInterests: result.detected_interests || [],
    });

    if (inserted) {
      console.log(`🎯 Scorer: queued recommendation "${matchedGroup.name}" for ${senderInboxId.slice(0, 12)}... (score: ${result.score})`);
    }
  } catch (err) {
    console.error("❌ Scorer error:", err);
  }
}

/** Match a group message against CPH subscriptions. Same intent logic as scoreMessage. */
export async function matchMessageToSubscriptions(params: {
  messageContent: string;
  subscriptions: CphSubscriptionCandidate[];
  sourceGroupId: string;
}): Promise<MatchSubscriptionsResult | null> {
  const { messageContent, subscriptions, sourceGroupId } = params;

  if (!openai) return null;
  if (!messageContent || messageContent.length < MIN_MESSAGE_LENGTH) return null;
  if (subscriptions.length === 0) return null;

  const list = subscriptions
    .filter((s) => s.xmtp_group_id !== sourceGroupId)
    .map((s, i) => `${i + 1}. [ID: ${s.id}] interests: [${s.interests.slice(0, 10).join(", ")}]`)
    .join("\n");
  if (!list) return null;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `You are an intent scorer. A user sent a message in a group chat. Detect if they are genuinely engaged with a topic that matches any subscription's interests.

Rate 0-100. Return JSON: {"score": number, "reasoning": "brief", "detected_interests": ["tag1"], "suggested_subscription_id": number or null}

Subscription interests (subscription_id = numeric ID):
${list}

Rules: Match based on what they're TALKING ABOUT. score >= 75 and suggested_subscription_id required for a match. Do NOT match source group (message is from a different group). Greetings/single words = under 30.`,
        },
        { role: "user", content: messageContent },
      ],
      max_tokens: 120,
      temperature: 0.1,
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    const jsonStr = raw.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(jsonStr) as { score: number; reasoning: string; detected_interests?: string[]; suggested_subscription_id: number | null };

    if (result.score < SCORE_THRESHOLD || result.suggested_subscription_id == null) return null;
    const sub = subscriptions.find((s) => s.id === result.suggested_subscription_id);
    if (!sub) return null;

    return {
      subscriptionId: sub.id,
      score: result.score,
      reasoning: result.reasoning,
      detected_interests: result.detected_interests || [],
    };
  } catch (err) {
    console.error("❌ CPH matcher error:", err);
    return null;
  }
}
