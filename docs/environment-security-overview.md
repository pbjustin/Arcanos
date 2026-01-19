# Keeping ARCANOS Safe in Different Environments

If you're running ARCANOS, you want to know that it's operating in a place we trust. The new **environment safety layer** does exactly that. Here's what it means in everyday language:

## Why we added this

* ARCANOS can be installed in lots of places (your laptop, a company server, a hosting service).
* Some environments might be missing important pieces or could have been changed without us knowing.
* When that happens, ARCANOS might behave in unexpected ways.

## How the safety layer protects you

1. **Quick health quiz at startup** – Every time ARCANOS turns on, it asks the operating system a few simple questions: “What kind of machine am I on? Which version of Node.js is here? Which version of ARCANOS am I running?” We compare the answers with a small list of locations we have already tested and approved.
2. **Safe test drive** – We spin up a temporary, isolated copy of Node.js and let it try a couple of basic actions (like calling `fetch`). If the car stalls during this mini test drive, we know something is off.
3. **House rules** – If either of those checks looks suspicious, ARCANOS switches itself into **safe mode**. In safe mode we avoid any actions that could damage your data or make unexpected external calls. Think of it as ARCANOS switching to “read-only and cautious” until a human takes a look.
4. **Status report you can read** – The startup screen, health check endpoint, and logs now say clearly whether we are on trusted ground or running with the brakes on.

## What you’ll notice

* When everything is normal, you will see a log line such as `Trusted environment fingerprint confirmed` and the startup report will say `Trusted: ✅`.
* If ARCANOS sees something unfamiliar, the startup report and logs will say `Safe Mode: ENABLED` along with a short note about what looked wrong.
* Health checks now show the same information so your monitoring can alert you if we drop into safe mode.

## What to do if you see safe mode

1. Double-check that you are deploying ARCANOS to one of the supported environments (Docker image, Railway, or your approved setup).
2. Make sure the machine has the expected Node.js version installed.
3. If you still see safe mode, share the fingerprint string from the startup report with your support contact so we can review it together.

With these safeguards in place, ARCANOS lets you know when everything is good—or when it needs a little attention—without requiring you to be an infrastructure expert.
