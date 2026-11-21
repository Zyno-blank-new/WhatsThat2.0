# What’sThat? 2.0

What if Gemini could help you with what you just saw in Chrome? What’sThat? is an independent **Element 119** hackathon prototype. It keeps the last 10 seconds of the enabled tab, then uses the recording and a fresh screenshot to fill a dark Chrome side panel with short, context-specific chips.

## Load in Chrome

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this repo’s `extension` directory. If it’s already loaded, click **Reload** to apply the new permissions and code.
2. Open What’sThat? from its toolbar icon. Select **Set Gemini key** in the sidebar. Enter your hackathon key, or choose **Import .env.local** and select the file with your saved `GEMINI_API_KEY`. Click **Save key**. On macOS, press **Command–Shift–.** in the file picker to show hidden files.
3. On a webpage or video, press **Option–Shift–Q** on macOS or **Alt–Shift–Q** elsewhere to enable lookback. You can also select **Enable lookback** in the panel.
4. After viewing or scrolling for at least 10 seconds, press **Option–Q** or **Alt–Q**. Click **View clip** to verify the video and audio. If a shortcut is assigned elsewhere, change it at `chrome://extensions/shortcuts`.

Lookback captures the enabled tab’s video and audio, restores tab audio output, and keeps a rolling WebM buffer in memory. Chrome capture starts when enabled. The playable clip starts at an encoded keyframe inside the preceding 10-second window, so it may be a fraction of a second shorter. Restricted browser pages and some protected video can limit capture. Navigation or selecting a different tab in the same window ends lookback. A screenshot-only request is available before lookback has collected a clip.

## Models and integrations

| Component | Hackathon implementation |
|---|---|
| Gemini 3.5 Flash-Lite | Generates the first one or two specific questions from the screenshot and clip in parallel with Hydrogen. The sidebar displays short labels for them. |
| Gemini 4 Hydrogen | Uses the fresh screenshot as the primary evidence and the full WebM clip for recent activity and speech. Returns dynamically grouped chip labels and grounded lookup candidates. It generates an explanation when the user opens a chip. |
| Gemini Decision 1 | Identifies repeated topics in the final suggestions and evaluates whether shopping and web searches are useful. Relevant searches start automatically. |
| Gemini 4 Neon | Uses Google Search grounding for cited explanations, references, current prices, and reviews. |
| Shopify Global Catalog MCP | Searches across Shopify merchants for similar products, using an explicit USD budget if one was supplied. Displays live featured variants, prices, and merchant links. The prototype uses Shopify’s documented example agent profile. |

The sidebar calls Gemini, the Decisions API, and Shopify directly. For a page with an explicit product name, routing can start alongside Hydrogen. For an item in a recording, routing starts when Hydrogen identifies it. The full analysis updates the initial suggestions while keeping any chip the user has opened. Click a chip to ask its specific question or open available lookup results. The user can ask a follow-up about the same frozen capture. Each installation saves its own Gemini key in local Chrome extension storage, restricted to trusted extension pages. Uploads start after a shortcut, toolbar analyze action, or an answer request.

## Verification and judging

- With Node.js 22 or newer, run `npm test` for provider and settings checks. These tests simulate responses to verify model IDs, the combined video and screenshot payload, citations, and Shopify listings.
- For the live demo, use a clip you have permission to show. Turn captions off, let an item go off screen, then press the shortcut. Check whether the suggestions retain the product and its spoken constraints.
- Test a separate set of untuned real clips and pages, including noisy audio, fast scrolling, and incidental background products. Compare the screenshot-only route with the full capture using the same frame and timestamp as closely as possible.
- Record capture-to-first-useful-chip latency, whether the item and constraints were identified, and whether Shopify and Search were routed appropriately. Inspect the sidebar console for keypress-to-first-chip timing. Two seconds is the target for the first useful label. Track answer latency separately, from chip click to explanation.
- Record one genuine failure and the change made after observing it. Provider contract tests are development checks. Use real inputs for the judging evaluation.

The previous ADA project is the conceptual reference. The Manifest V3 panel, rolling screen-and-audio recorder, Gemini 4 workflows, Decisions API routing, and Shop integration are the new implementation in this repository.
