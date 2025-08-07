#!/usr/bin/env node

import { Probot } from "probot";
import probotApp from "./probot-app.js";
import { readFileSync } from "fs";

// Create Probot instance and load our app
const probot = new Probot({
  appId: process.env.APP_ID,
  privateKey: process.env.PRIVATE_KEY || readFileSync(process.env.PRIVATE_KEY_PATH || "./private-key.pem"),
  secret: process.env.WEBHOOK_SECRET,
});

probot.load(probotApp);

// Start the server
probot.start();