-- ===========================================================================
--  032 · the halt swap is APPLIED, not only requested (G-1)
-- ===========================================================================
--  spread:slotRequest was a socket event to the terminal — it never reached the
--  scraper, so the ladder a halt needs for size and stop was never actually
--  swept. The backend now HTTP-POSTs POST /ingest/slots/:n on the halt, and
--  records the outcome here so no path ends with nothing recorded:
--    slot_applied        the slot the scraper actually took (null if none)
--    slot_applied_at     when the scraper confirmed it
--    replaced_symbol     what the scraper dropped for it
--    slot_refused_reason why it could not be applied (SCRAPER_UNREACHABLE, …)
-- ===========================================================================
ALTER TABLE spread.halt_event
  ADD COLUMN IF NOT EXISTS slot_applied        integer,
  ADD COLUMN IF NOT EXISTS slot_applied_at     timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_symbol     text,
  ADD COLUMN IF NOT EXISTS slot_refused_reason text;
