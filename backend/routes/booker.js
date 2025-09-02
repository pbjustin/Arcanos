import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import { Client as NotionClient } from "@notionhq/client";

dotenv.config();

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const FINETUNE_MODEL = process.env.FINETUNE_MODEL;
const notion = new NotionClient({ auth: process.env.NOTION_API_KEY });
const WWE_DATABASE_ID = process.env.WWE_DATABASE_ID;

// ---- Memory State ----
let currentState = {
  storylines: [],
  feuds: [],
  events: []
};
const SNAPSHOT_DIR = "./snapshots";
const AUDIT_LOG = "./audit.log";

if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR);

// ---- Snapshot Manager ----
function saveSnapshot(state) {
  const file = `${SNAPSHOT_DIR}/snapshot_${Date.now()}.json`;
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
  currentState = state;
}
function rollback() {
  const files = fs.readdirSync(SNAPSHOT_DIR).sort().reverse();
  if (files.length > 0) {
    const last = JSON.parse(fs.readFileSync(`${SNAPSHOT_DIR}/${files[0]}`));
    currentState = last;
    return { rolled_back: true, state: last };
  }
  return { rolled_back: false, state: currentState };
}

// ---- Notion Roster Fetch ----
async function fetchRoster() {
  if (!WWE_DATABASE_ID) {
    throw new Error("WWE_DATABASE_ID is not configured");
  }
  const response = await notion.databases.query({ database_id: WWE_DATABASE_ID });
  return response.results.map(page => {
    const title = page.properties?.Name?.title;
    return title?.length > 0 ? title[0].plain_text : "Unnamed Entry";
  });
}

// ---- Storyline Engine ----
async function storylineEngine(query, roster) {
  const response = await openai.chat.completions.create({
    model: FINETUNE_MODEL,
    messages: [
      { role: "system", content: "ARCANOS:BOOKER storyline engine. Build WWE Universe feuds, arcs, and promos." },
      { role: "user", content: `${query.prompt}\nRoster: ${roster.join(', ')}` }
    ],
    temperature: 0.65
  });
  return {
    branchId: `story_${Date.now()}`,
    outcome: response.choices[0].message.content
  };
}

// ---- Feud Tracker ----
function feudTracker(superstars, outcome) {
  const feud = {
    id: `feud_${Date.now()}`,
    superstars,
    outcome,
    length: 1
  };
  currentState.feuds.push(feud);
  return feud;
}

// ---- Event Scheduler ----
async function eventScheduler(query, storyline) {
  const response = await openai.chat.completions.create({
    model: FINETUNE_MODEL,
    messages: [
      { role: "system", content: "ARCANOS:BOOKER event scheduler. Create weekly shows and PPV cards for WWE Universe Mode." },
      { role: "user", content: storyline.outcome }
    ],
    temperature: 0.55
  });
  return {
    id: `event_${Date.now()}`,
    matches: response.choices[0].message.content.split("\n").filter(l => l.trim())
  };
}

// ---- Booking Controller ----
async function handleBooking(query) {
  const auditLog = {
    received_at: new Date().toISOString(),
    storyline_branch: null,
    feud_update: null,
    event_card: null,
    rule_flags: [],
    rollback_enabled: true
  };

  try {
    const roster = await fetchRoster();
    auditLog.roster_size = roster.length;
    const storyline = await storylineEngine(query, roster);
    auditLog.storyline_branch = storyline.branchId;

    const feudUpdate = feudTracker(query.superstars || [], storyline.outcome);
    auditLog.feud_update = feudUpdate.id;

    const eventCard = await eventScheduler(query, storyline);
    auditLog.event_card = eventCard.id;

    if (feudUpdate.length > 8) {
      auditLog.rule_flags.push("FEUD_TOO_LONG");
    }
    if (eventCard.matches.length === 0) {
      auditLog.rule_flags.push("EMPTY_EVENT_CARD");
    }

    saveSnapshot({ storylines: [storyline], feuds: [feudUpdate], events: [eventCard] });

    fs.appendFileSync(AUDIT_LOG, JSON.stringify(auditLog) + "\n");

    return { storyline, feudUpdate, eventCard, auditLog };
  } catch (err) {
    console.error("❌ BOOKER Error:", err);
    return rollback();
  }
}

// ---- Express Endpoint ----
router.post("/", async (req, res) => {
  try {
    const response = await handleBooking(req.body);
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: "Internal failure", details: err.message });
  }
});

router.get("/roster", async (_req, res) => {
  try {
    const roster = await fetchRoster();
    res.json({ count: roster.length, roster });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch roster", details: err.message });
  }
});

export default router;

