# What’sThat? 2.1

What if Gemini could help you with what you just saw in Chrome? What’sThat? is an independent **Element 119** hackathon prototype. It keeps up to 10 seconds of the active tab’s video and audio, then uses that clip to suggest questions and actions in a dark Chrome side panel.

## Load in Chrome

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this repo’s `extension` directory. If it’s already loaded, click **Reload** to apply the new permissions and code.
2. Open What’sThat? from its toolbar icon. Select **Set Gemini key** in the sidebar. Enter your hackathon key, or choose **Import .env.local** and select the file with your saved `GEMINI_API_KEY`. Click **Save key**. On macOS, press **Command–Shift–.** in the file picker to show hidden files.
3. On a new webpage or video tab, press **Option–Shift–Q** on macOS or **Alt–Shift–Q** elsewhere to grant access and start Lookback with the sidebar closed. This shortcut also toggles recording for the active tab.
4. Press **Option–Q** on macOS or **Alt–Q** elsewhere to open the sidebar and analyze the buffered moment. Click **View clip** to play it. Manage shortcut assignments at `chrome://extensions/shortcuts`.

Lookback restores tab audio output and keeps a rolling WebM buffer in memory. Chrome requires a click or shortcut before granting audio and video access to a new tab. When an authorized tab becomes active again, Lookback resumes without the sidebar open. It stops when you leave Chrome or switch away from the tab. A pause lasts for the browser session until you resume that tab. Navigation clears the previous page’s buffer and a new site can require Chrome authorization again. The playable clip starts at a keyframe inside the 10-second window. Restricted browser pages and some protected video can limit capture.

## Models and integrations

| Component | Hackathon implementation |
|---|---|
| Gemini 3.5 Flash-Lite | Uses roughly the latest three seconds of WebM to plan early headings, prepare up to two instant answers, and identify distinctive products. Approved products and clear named references can start lookups while Hydrogen analyzes the entire lookback. |
| Gemini 4 Hydrogen | Reads the clip and prioritizes its final two seconds. Chooses sections, questions, and likely next actions with evidence from the clip. Explains the topic on demand and identifies when a public source would help. |
| Gemini Decision 1 | Identifies repeated topics, screens lookups against their evidence, and checks each returned merchant listing against the captured item before displaying it. |
| Gemini 4 Neon | Uses Google Search grounding to find specific destinations and cite reviews, prices, and other factual answers. It also verifies selected chip and typed answers from a public text query. Independent approved searches run in parallel. |
| Shopify Global Catalog MCP | Searches across Shopify merchants for matching products, using an explicit USD budget if one was supplied. Displays available variants, catalog images, prices, and merchant links. The prototype uses Shopify’s documented example agent profile. |

The sidebar calls Gemini, the Decisions API, and Shopify directly. It shows skeletons while Gemini chooses which sections to display, their headings, and their order. Explanations and verified cards fill those sections as results arrive. The full analysis can retitle or reorder sections while preserving an opened chip. Direct cards can show cited research papers, profiles, videos, guides, tours, recipes, or ordering pages from Google Search. Each installation saves its own Gemini key in local Chrome extension storage. The WebM clip contains the tab’s video and audio and is the sole media input to Gemini. Uploads start when you analyze or ask a question.

The scene card puts the main subject and a local preview of the recorded clip at the top. Recognizable dishes get a quick cooking tip, recipe links, and relevant grocery ingredients. Recipe, retailer, visitor, and general page lookups start with grounded Flash-Lite. Destination searches can retry with Neon when the first attempt returns no usable citations. The food lookups can start while the Decisions API evaluates the scene.

Shopping searches Shopify Global Catalog MCP and Google Search in parallel using the item name and visible features, including clearly identified parts of custom objects. The catalog fetches extra candidates so the Decisions API can rank matches and discard unrelated items. Approved matches appear as their source finishes. The shopping section disappears when all searches finish without a match. Unknown brands and models are labeled as similar matches. On an identifiable product detail page, Gemini can choose a section for a cited review summary and review cards.

Chip answers are prepared during the analysis and appear on click. A public fact can still receive cited verification in the background. The sidebar looks for related YouTube videos for identifiable landmarks alongside ticket and tour links. Video cards use YouTube thumbnails for verified video IDs. Visitor cards use a freely licensed photo of the landmark and link to the Wikimedia Commons credit when available. Other links use a site favicon or built-in icon.

## Verification and judging

- With Node.js 22 or newer, run `npm test` for provider and settings checks. These tests simulate responses to verify model IDs, the video-only payload, per-lookup routing, citation-backed destination cards, and Shopify listings.
- For the live demo, use a clip you have permission to show. Turn captions off, let an item go off screen, then press the shortcut. Check whether the suggestions retain the product and its spoken constraints.
- Test a separate set of untuned real clips and pages, including noisy audio, fast scrolling, and incidental background products. Compare the screenshot-only route with the full capture using the same frame and timestamp as closely as possible.
- Record whether the item and its constraints were identified and whether Shopify and Search were routed appropriately. Inspect the sidebar console for keypress-to-first-chip and keypress-to-first-product-card timings. Two seconds is the target for the first useful label. Track answer latency separately, from chip click to explanation.
- Record one genuine failure and the change made after observing it. Provider contract tests are development checks. Use real inputs for the judging evaluation.

The previous ADA project is the conceptual reference. The Manifest V3 panel, rolling screen-and-audio recorder, Gemini 4 workflows, Decisions API routing, and Shop integration are the new implementation in this repository.
