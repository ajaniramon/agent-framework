- The closed-channel invitation's "reply without joining" prefix is now always one
  whitespace-free token that resolves back to the channel (`@name` for a DM, else `#label`,
  `#name` without the server suffix, or the channel id), from the new
  `ChannelRegistry.proseTargetFor()`. It used to quote the label verbatim, and the prefix
  grammar reads the target as the first non-whitespace run: a DM labelled `DM: alice` gave
  `>>#DM: alice` (target `#DM:`, body `alice …`, so the reply bounced and the retained text
  went out with a stray `alice` line), and a suffixed label like `#fable (antra's server)`
  delivered `(antra's server)` as text.
