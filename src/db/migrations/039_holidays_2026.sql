-- ===========================================================================
--  039_holidays_2026.sql — Boursa Kuwait's published 2026 market holidays
--
--  A holiday is not a failure. The daily jobs fail LOUDLY on an unexpected
--  empty session day (a capture defect), but a day marked closed here is a
--  skip with a log line. Source: boursakuwait.com.kw › Trading › Market
--  Holidays (2026), fetched 10 Sep 2026. "Holidays may be subject to change
--  due to the Hijri calendar or decisions by the Council of Ministers" — an
--  added closure is one INSERT here or via `npm run calendar`.
--
--  A day that TRADED is a session whatever this list says (observation beats
--  the calendar): the update is skipped where quotes exist for the date.
-- ===========================================================================
INSERT INTO spread.trading_day (trading_day, is_session, holiday_name)
VALUES
  ('2026-01-01', false, 'New Year'),
  ('2026-01-18', false, 'Ascension of Prophet Mohammed'),
  ('2026-02-25', false, 'National Day'),
  ('2026-02-26', false, 'Liberation Day'),
  ('2026-03-19', false, 'Eid Al Fitr'),
  ('2026-03-22', false, 'Eid Al Fitr'),
  ('2026-05-26', false, 'Arafat Day'),
  ('2026-05-27', false, 'Eid Al Adha'),
  ('2026-05-28', false, 'Eid Al Adha'),
  ('2026-06-16', false, 'Hijri New Year'),
  ('2026-08-27', false, 'Prophet Mohammed Birthday')
ON CONFLICT (trading_day) DO UPDATE
  SET is_session = false, holiday_name = EXCLUDED.holiday_name
  WHERE NOT EXISTS (SELECT 1 FROM public.awsat_market_quotes q WHERE q.trading_date = EXCLUDED.trading_day);
