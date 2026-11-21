# What’sThat? 2.0

What if Gemini could help you with what you just saw in Chrome? What’sThat? is an independent **Element 119** hackathon prototype. It keeps up to 10 seconds of the active tab’s video and audio, then uses that clip to fill a dark Chrome side panel with short, context-specific chips.

## Load in Chrome

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this repo’s `extension` directory. If it’s already loaded, click **Reload** to apply the new permissions and code.
2. Open What’sThat? from its toolbar icon. Select **Set Gemini key** in the sidebar. Enter your hackathon key, or choose **Import .env.local** and select the file with your saved `GEMINI_API_KEY`. Click **Save key**. On macOS, press **Command–Shift–.** in the file picker to show hidden files.
3. On a webpage or video, press **Option–Q** on macOS or **Alt–Q** elsewhere. Chrome grants access to the tab, and What’sThat? starts lookback and opens the sidebar automatically.
4. After watching or scrolling for about 10 seconds, press the shortcut again for a full lookback window. Click **View clip** to play it. Use the sidebar’s lookback button or **Option–Shift–Q** (macOS) / **Alt–Shift–Q** to pause or start capture. Manage shortcut assignments at `chrome://extensions/shortcuts`.

Lookback restores tab audio output and keeps a rolling WebM buffer in memory. Chrome requires an extension gesture before recording a new tab, so its first clip is shorter. The playable clip starts at an encoded keyframe inside the 10-second window. When you switch tabs, lookback stops capturing the previous tab and can resume on the selected tab if Chrome has already granted access. Navigation clears the previous page’s buffer. Restricted browser pages and some protected video can limit capture.

## Models and integrations

| Component | Hackathon implementation |
|---|---|
| Gemini 3.5 Flash-Lite | Uses the WebM clip to choose up to two initial chips and their headings, in parallel with Hydrogen. |
| Gemini 4 Hydrogen | Prioritizes the final two seconds of the WebM clip and uses earlier frames and audio for additional context. Chooses section headings, chips, and lookup candidates. It generates an explanation when the user opens a chip. |
| Gemini Decision 1 | Identifies repeated topics in the final suggestions and evaluates whether shopping and web searches are useful. Relevant searches start automatically. |
| Gemini 4 Neon | Uses Google Search grounding for cited explanations, references, current prices, and reviews. |
| Shopify Global Catalog MCP | Searches across Shopify merchants for similar products, using an explicit USD budget if one was supplied. Displays live featured variants, prices, and merchant links. The prototype uses Shopify’s documented example agent profile. |

The sidebar calls Gemini, the Decisions API, and Shopify directly. It shows skeletons while it waits for chip labels. The full analysis updates the initial suggestions while keeping any chip the user has opened. Relevant product listings, independent reviews, price comparisons, and external references appear under AI-selected headings. Click a chip to ask its specific question or open lookup results. The user can ask a follow-up about the same frozen capture. Each installation saves its own Gemini key in local Chrome extension storage, restricted to trusted extension pages. The WebM clip contains the tab’s video and audio and is the sole media input to Gemini. Uploads start after a shortcut, toolbar analyze action, or an answer request.

## Verification and judging

- With Node.js 22 or newer, run `npm test` for provider and settings checks. These tests simulate responses to verify model IDs, the video-only payload, dynamic lookup groups, citations, and Shopify listings.
- For the live demo, use a clip you have permission to show. Turn captions off, let an item go off screen, then press the shortcut. Check whether the suggestions retain the product and its spoken constraints.
- Test a separate set of untuned real clips and pages, including noisy audio, fast scrolling, and incidental background products. Compare the screenshot-only route with the full capture using the same frame and timestamp as closely as possible.
- Record capture-to-first-useful-chip latency, whether the item and constraints were identified, and whether Shopify and Search were routed appropriately. Inspect the sidebar console for keypress-to-first-chip timing. Two seconds is the target for the first useful label. Track answer latency separately, from chip click to explanation.
- Record one genuine failure and the change made after observing it. Provider contract tests are development checks. Use real inputs for the judging evaluation.

The previous ADA project is the conceptual reference. The Manifest V3 panel, rolling screen-and-audio recorder, Gemini 4 workflows, Decisions API routing, and Shop integration are the new implementation in this repository.
