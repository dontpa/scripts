# V2EX userscript regression checks

Run from the repository root with Node.js. Browser checks require `playwright`
available to Node and its Chromium browser installed. When using an existing
runtime, set `NODE_PATH` and optionally `PLAYWRIGHT_EXECUTABLE_PATH`.

```sh
node --check v2ex-tweaks.user.js
node tests/v2ex-daily.cjs
node tests/v2ex-replies.cjs
node tests/v2ex-new-tab.cjs
node tests/v2ex-imgur-toggle.cjs
node tests/v2ex-tag-menu.cjs
node tests/v2ex-performance.cjs
```

- `v2ex-daily.cjs`: deterministic sign-in lock expiry and server confirmation.
- `v2ex-replies.cjs`: native thread order and nested containers, native collapse/reply
  controls, visible pagination, no page fetches, and safe unread progress.
- `v2ex-new-tab.cjs`: native default navigation, opt-in new-tab opening for topic
  and member links, the persistent userscript-manager menu switch, and preserved
  floor/external-link behavior.
- `v2ex-imgur-toggle.cjs`: independent Imgur proxy menu setting, existing-image
  restoration, reapplication, dynamically inserted images, and stable ordering
  of all userscript menu entries on managers without in-place updates.
- `v2ex-tag-menu.cjs`: userscript-manager tag export and import, including the
  existing merge preview and confirmation before stored tags change.
- `v2ex-performance.cjs`: 400-reply unread navigation caching, batched scans, incremental Base64 and Imgur handling.
  Timings are diagnostic; correctness assertions are the pass/fail criteria.

The tests use local fixtures and stub requests; they do not sign in to a real
account or modify live V2EX data. They do not replace checking the installed
userscript in each supported browser.
