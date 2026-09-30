- History tools, from a resident's diary-work feedback: `search` and `extract`
  take `author` / `excludeAuthor` (exact, case-insensitive match on
  `metadata.author` name or id; messages without author metadata, such as
  the agent's own turns, match on their stored participant). Results now carry `author`.
  `extract({aroundId, before, after})` returns the conversation around a
  message id from `search` (its own channel by default, `allChannels` to
  interleave). `search` adds `wholeWord` (Unicode-aware) and
  `order: "newest"`, and when it stops early (at `limit` or `maxScan`) it
  reports `scannedThrough` and `resume: {from|to, skipSequences}` to repeat
  the call with (`skipSequences` names the messages at that exact instant
  already scanned by sequence range, so a message added or removed there
  between calls is neither lost nor shifts the skip). `search` rejects
  `maxScan: 0`.
  An author-filtered `extract` that stops early returns
  `resume: {windowOffset, offset, afterId}` to repeat the call with (position,
  not timestamp, so late-appended backfill in a channel is not skipped). On
  resume, `afterId` pins the position: if messages were removed or inserted
  before it since the previous call, the scan re-anchors and reports
  `windowChanged: {shift}`; if the anchor itself is gone, it fails loudly
  instead of silently skipping. A resumed call reports
  `matchedSinceWindowOffset` rather than a total.
  `aroundId` also accepts a `semantic_search` `msg:<id>` hit id.
