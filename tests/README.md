# V2EX userscript regression checks

Run from the repository root with Node.js. Browser checks require `playwright`
available to Node and its Chromium browser installed. When using an existing
runtime, set `NODE_PATH` and optionally `PLAYWRIGHT_EXECUTABLE_PATH`.

```sh
node --check v2ex-tweaks.user.js
node tests/v2ex-daily.cjs
node tests/v2ex-tree-layout.cjs
node tests/v2ex-new-tab.cjs
node tests/v2ex-imgur-toggle.cjs
node tests/v2ex-tag-menu.cjs
node tests/v2ex-performance.cjs
```

- `v2ex-daily.cjs`: deterministic sign-in lock expiry and server confirmation.
- `v2ex-tree-layout.cjs`: responsive indentation, collapse persistence, ancestor
  navigation, header alignment, reference previews, resize redraws, unchanged
  SVG reuse, and deep reference parsing. Writes preview PNGs under `/tmp`.
- `v2ex-new-tab.cjs`: native default navigation, opt-in new-tab opening for topic
  and member links, the persistent userscript-manager menu switch, and preserved
  floor/external-link behavior.
- `v2ex-imgur-toggle.cjs`: independent Imgur proxy menu setting, existing-image
  restoration, reapplication, and dynamically inserted images.
- `v2ex-tag-menu.cjs`: userscript-manager tag export and import, including the
  existing merge preview and confirmation before stored tags change.
- `v2ex-performance.cjs`: repeat rendering of 400 replies, a 20,000-level forest,
  unread navigation caching, batched scans, incremental Base64 and Imgur handling.
  Timings are diagnostic; correctness assertions are the pass/fail criteria.

The tests use local fixtures and stub requests; they do not sign in to a real
account or modify live V2EX data. They do not replace checking the installed
userscript in each supported browser.

For an internal optimization, save the accepted script before editing and set
`V2EX_BASELINE_FILE=/absolute/path/to/baseline.user.js`. Both browser checks support
this: layout runs the baseline fixture, while performance compares baseline and
current DOM output. Use only a baseline with the same intended UI; a deliberate
layout change will correctly fail the exact DOM comparison.
