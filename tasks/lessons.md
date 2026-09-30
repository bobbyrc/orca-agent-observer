# Lessons

- For any API collection consumed by a UI, validate the settled tree against representative real metadata before declaring browser integration verified. Assert every ID is nonempty and unique, and check the full response contract; row counts alone cannot catch missing or duplicate identities.
- In an agent observer, never present a transcript or file selection count where it could be mistaken for the number of currently active workers. Show verified liveness status beside that count, or state explicitly when liveness is unavailable. Distinguish the file modification lookback window from the recency of the last event shown.
