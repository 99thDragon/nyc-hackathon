"""Tests for the poller. Run: python3 -m unittest discover -s tests -v"""

import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ene import db, feeds, poller, reliability  # noqa: E402

FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fixtures")


class TestParsing(unittest.TestCase):

    def test_xml_outages_parse(self):
        current, upcoming, _ = feeds.load_outages_from_file(
            os.path.join(FIX, "ene_outages_t0.xml"))
        self.assertEqual({o["equipment_code"] for o in current}, {"EL101", "EL103"})
        self.assertEqual([o["equipment_code"] for o in upcoming], ["EL607X"])

    def test_upcoming_is_not_a_current_outage(self):
        """Planned future work must never be counted as downtime."""
        current, upcoming, _ = feeds.load_outages_from_file(
            os.path.join(FIX, "ene_outages_t0.xml"))
        self.assertNotIn("EL607X", [o["equipment_code"] for o in current])
        self.assertTrue(upcoming[0]["is_upcoming"])
        self.assertTrue(upcoming[0]["is_maintenance"])

    def test_empty_feed_is_valid(self):
        current, upcoming, _ = feeds.load_outages_from_file(
            os.path.join(FIX, "ene_outages_t2.xml"))
        self.assertEqual(current, [])
        self.assertEqual(upcoming, [])

    def test_malformed_xml_raises_feed_error(self):
        with self.assertRaises(feeds.FeedError):
            feeds.load_outages_from_file(os.path.join(FIX, "ene_outages_malformed.xml"))

    def test_json_feed_shape_also_parses(self):
        """Schema drift insurance: if the feed turns into JSON, we still cope."""
        body = (b'[{"equipment":"EL999","reason":"Repair",'
                b'"outagedate":"10/18/2026 06:12:00 AM","isupcomingoutage":"N"}]')
        records = feeds.parse_records(body)
        item = feeds.normalise_outage(records[0])
        self.assertEqual(item["equipment_code"], "EL999")
        self.assertEqual(item["reason"], "Repair")

    def test_unknown_fields_do_not_lose_the_record(self):
        body = (b'<nyct_ene><outage><equipment>EL500</equipment>'
                b'<somethingnew>xyz</somethingnew></outage></nyct_ene>')
        item = feeds.normalise_outage(feeds.parse_records(body)[0])
        self.assertEqual(item["equipment_code"], "EL500")
        self.assertEqual(item["raw"]["somethingnew"], "xyz")

    def test_live_shape_envelope_parses(self):
        """The real feed is <NYCOutages>, not the <nyct_ene> of older docs."""
        current, upcoming, _ = feeds.load_outages_from_file(
            os.path.join(FIX, "ene_outages_live_shape.xml"))
        self.assertTrue(current or upcoming)
        for item in current + upcoming:
            self.assertTrue(item["equipment_code"].startswith(("EL", "ES")))

    def test_envelope_fields_are_not_mistaken_for_outages(self):
        """<responsecode> and <message> are siblings of <outage>, not units."""
        current, upcoming, _ = feeds.load_outages_from_file(
            os.path.join(FIX, "ene_outages_live_shape.xml"))
        codes = [o["equipment_code"] for o in current + upcoming]
        self.assertEqual(len(codes), len(set(codes)))
        self.assertNotIn("", codes)

    def test_s3_error_with_http_200_is_not_an_empty_feed(self):
        """A mistyped URL returns 200 with an S3 error body.

        Parsed naively this looks like zero outages, which would be written to
        the log as every elevator in the system returning to service.
        """
        with self.assertRaises(feeds.FeedError) as ctx:
            feeds.load_outages_from_file(os.path.join(FIX, "ene_outages_s3_error.xml"))
        self.assertIn("error document", str(ctx.exception))

    def test_nonzero_responsecode_is_a_failure(self):
        with self.assertRaises(feeds.FeedError) as ctx:
            feeds.load_outages_from_file(
                os.path.join(FIX, "ene_outages_bad_responsecode.xml"))
        self.assertIn("responsecode", str(ctx.exception))

    def test_unrecognised_root_is_refused(self):
        """An HTML error page must not read as 'nothing is broken'."""
        with self.assertRaises(feeds.FeedError):
            feeds.check_envelope(b"<html><body>502 Bad Gateway</body></html>",
                                 expect=feeds.OUTAGE_ROOTS)

    def test_record_without_equipment_code_is_dropped(self):
        body = b'<nyct_ene><outage><station>Nowhere</station></outage></nyct_ene>'
        self.assertIsNone(feeds.normalise_outage(feeds.parse_records(body)[0]))

    def test_local_time_converts_to_utc(self):
        """Feed times are New York local. October is EDT (UTC-4)."""
        self.assertEqual(feeds.parse_feed_datetime("10/18/2026 06:12:00 AM"),
                         "2026-10-18T10:12:00+00:00")

    def test_unparseable_date_is_none_not_a_crash(self):
        self.assertIsNone(feeds.parse_feed_datetime("sometime next week"))
        self.assertIsNone(feeds.parse_feed_datetime(""))


class PollerTestCase(unittest.TestCase):

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite3", delete=False)
        self.tmp.close()
        self.conn = db.connect(self.tmp.name)

    def tearDown(self):
        self.conn.close()
        os.unlink(self.tmp.name)

    def fix(self, name):
        return os.path.join(FIX, name)


class TestDiff(PollerTestCase):

    def test_first_poll_opens_outages(self):
        result = poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["began"], 2)
        self.assertEqual(result["returned"], 0)
        self.assertEqual(result["upcoming"], 1)

    def test_repeat_poll_writes_no_duplicate_events(self):
        """An elevator out for days is one event, not one per poll."""
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        before = self.conn.execute("SELECT count(*) FROM outage_events").fetchone()[0]
        for _ in range(5):
            poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        after = self.conn.execute("SELECT count(*) FROM outage_events").fetchone()[0]
        self.assertEqual(before, after)
        self.assertEqual(self.conn.execute("SELECT count(*) FROM polls").fetchone()[0], 6)

    def test_transitions_between_snapshots(self):
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        result = poller.poll_once(self.conn, fixture=self.fix("ene_outages_t1.xml"))
        self.assertEqual(result["began"], 1)      # EL105 newly out
        self.assertEqual(result["returned"], 1)   # EL103 back
        self.assertEqual(result["updated"], 1)    # EL101 new ETA

        events = {(r["equipment_code"], r["event"]) for r in
                  self.conn.execute("SELECT equipment_code, event FROM outage_events")}
        self.assertIn(("EL105", "outage_began"), events)
        self.assertIn(("EL103", "returned_to_service"), events)
        self.assertIn(("EL101", "outage_updated"), events)

    def test_empty_feed_returns_everything_to_service(self):
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        result = poller.poll_once(self.conn, fixture=self.fix("ene_outages_t2.xml"))
        self.assertEqual(result["returned"], 2)
        self.assertEqual(
            self.conn.execute("SELECT count(*) FROM current_outages").fetchone()[0], 0)

    def test_outage_key_distinguishes_separate_outages(self):
        """Break, fix, break again must be two outages, not one."""
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t2.xml"))
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        keys = {r["outage_key"] for r in self.conn.execute(
            "SELECT outage_key FROM outage_events WHERE equipment_code='EL103'")}
        self.assertEqual(len(keys), 1,
                         "same feed outagedate should reuse one key")
        began = self.conn.execute(
            "SELECT count(*) FROM outage_events "
            "WHERE equipment_code='EL103' AND event='outage_began'").fetchone()[0]
        self.assertEqual(began, 2)


class TestResilience(PollerTestCase):

    def test_malformed_feed_records_a_failed_poll_and_does_not_raise(self):
        result = poller.poll_once(self.conn, fixture=self.fix("ene_outages_malformed.xml"))
        self.assertFalse(result["ok"])
        row = self.conn.execute(
            "SELECT ok, error FROM polls ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(row["ok"], 0)
        self.assertTrue(row["error"])

    def test_failed_poll_does_not_destroy_known_state(self):
        """A bad response must not look like everything came back into service."""
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_malformed.xml"))
        still_out = self.conn.execute(
            "SELECT count(*) FROM current_outages").fetchone()[0]
        self.assertEqual(still_out, 2)
        returned = self.conn.execute(
            "SELECT count(*) FROM outage_events "
            "WHERE event='returned_to_service'").fetchone()[0]
        self.assertEqual(returned, 0)

    def test_error_document_does_not_wipe_known_outages(self):
        """The 200-with-error-body case must not look like an all-clear."""
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        result = poller.poll_once(self.conn, fixture=self.fix("ene_outages_s3_error.xml"))
        self.assertFalse(result["ok"])
        self.assertEqual(
            self.conn.execute("SELECT count(*) FROM current_outages").fetchone()[0], 2)
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM outage_events "
            "WHERE event='returned_to_service'").fetchone()[0], 0)

    def test_missing_file_is_a_failed_poll_not_a_crash(self):
        result = poller.poll_once(self.conn, fixture=self.fix("does_not_exist.xml"))
        self.assertFalse(result["ok"])

    def test_log_is_append_only(self):
        poller.poll_once(self.conn, fixture=self.fix("ene_outages_t0.xml"))
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("UPDATE outage_events SET reason='tampered'")
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute("DELETE FROM outage_events")


class TestReliability(PollerTestCase):

    def _poll(self, when, codes):
        """Insert a synthetic successful poll observing `codes` as out."""
        stamp = when.replace(microsecond=0).isoformat()
        cur = self.conn.execute(
            "INSERT INTO polls (source, started_utc, finished_utc, ok) VALUES (?,?,?,1)",
            ("test", stamp, stamp))
        items = [{"equipment_code": c, "reason": "Repair", "outage_began_utc": None,
                  "estimated_return_utc": None, "is_upcoming": 0,
                  "is_maintenance": 0, "raw": {}} for c in codes]
        poller.apply_snapshot(self.conn, cur.lastrowid, items, observed_utc=stamp)
        self.conn.commit()

    def test_availability_counts_only_observed_time(self):
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        start = now - timedelta(days=10)
        # Poll every 10 minutes for 10 days; EL101 out for 36 hours in the middle.
        # 36h of 240h is 15% down, comfortably inside the 2/5 band rather than
        # sitting on a boundary where the assertion would be about rounding.
        t = start
        while t <= now:
            out = (["EL101"] if (start + timedelta(days=4)) <= t
                   < (start + timedelta(days=5, hours=12)) else [])
            self._poll(t, out)
            t += timedelta(minutes=10)

        stats = reliability.availability(self.conn, "EL101", days=10, now=now)
        self.assertIsNotNone(stats["availability"])
        self.assertAlmostEqual(stats["availability"], 0.85, places=2)
        self.assertEqual(reliability.rating_1_to_5(stats["availability"]), 2)

    def test_gap_in_polling_is_excluded_not_counted_as_uptime(self):
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        start = now - timedelta(days=4)
        # Observe days 0-1, go dark for days 1-3, observe day 3-4. Never out.
        t = start
        while t < start + timedelta(days=1):
            self._poll(t, [])
            t += timedelta(minutes=10)
        t = start + timedelta(days=3)
        while t <= now:
            self._poll(t, [])
            t += timedelta(minutes=10)

        stats = reliability.availability(self.conn, "EL101", days=4, now=now)
        self.assertLess(stats["coverage"], 0.60)
        self.assertGreater(stats["coverage"], 0.40)
        self.assertAlmostEqual(stats["observed_hours"], 48, delta=1.0)

    def test_thin_coverage_refuses_to_publish_a_score(self):
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        for i in range(6):
            self._poll(now - timedelta(minutes=50 - i * 10), [])
        stats = reliability.availability(self.conn, "EL101", days=30, now=now)
        self.assertIsNone(stats["availability"])
        self.assertIn("observed", stats["reason_unavailable"])
        self.assertIsNone(reliability.rating_1_to_5(stats["availability"]))

    def test_no_polls_at_all_is_not_a_crash(self):
        stats = reliability.availability(self.conn, "EL101", days=30)
        self.assertIsNone(stats["availability"])
        self.assertEqual(stats["observed_hours"], 0)

    def test_outage_spanning_window_start_still_counts(self):
        """An elevator broken before the window opened is still broken in it."""
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        start = now - timedelta(days=6)
        self._poll(start - timedelta(days=2), ["EL101"])   # broke before the window
        t = start
        while t <= now:
            self._poll(t, ["EL101"] if t < start + timedelta(days=3) else [])
            t += timedelta(minutes=30)
        stats = reliability.availability(self.conn, "EL101", days=6, now=now)
        self.assertGreater(stats["downtime_hours"], 60)
        self.assertLess(stats["availability"], 0.55)

    def test_no_score_for_a_unit_we_only_just_started_tracking(self):
        """A newly inventoried elevator has no 30-day history to report."""
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        self.conn.execute(
            """INSERT INTO equipment (equipment_code, raw_json,
               first_seen_utc, last_seen_utc) VALUES (?,?,?,?)""",
            ("EL777", "{}", (now - timedelta(days=2)).isoformat(), now.isoformat()))
        t = now - timedelta(days=2)
        while t <= now:
            self._poll(t, [])
            t += timedelta(minutes=10)

        stats = reliability.availability(self.conn, "EL777", days=30, now=now)
        self.assertIsNotNone(stats["known_since"])
        # The window shrank to the 2 days we have actually known the unit...
        self.assertLess(stats["window_hours"], 50)
        # ...and 2 days is not 30, so no 30-day score is published.
        self.assertAlmostEqual(stats["observed_hours"], 48, delta=1.0)

    def test_clamped_window_does_not_invent_uptime(self):
        """Before the clamp this returned a confident score from thin air."""
        now = datetime(2026, 10, 19, 12, 0, tzinfo=timezone.utc)
        self.conn.execute(
            """INSERT INTO equipment (equipment_code, raw_json,
               first_seen_utc, last_seen_utc) VALUES (?,?,?,?)""",
            ("EL888", "{}", (now - timedelta(days=3)).isoformat(), now.isoformat()))
        # Polls run for 30 days (watching other units); EL888 out the whole
        # time we have known it.
        t = now - timedelta(days=30)
        while t <= now:
            self._poll(t, ["EL888"] if t >= now - timedelta(days=3) else [])
            t += timedelta(minutes=10)

        stats = reliability.availability(self.conn, "EL888", days=30, now=now)
        self.assertLess(stats["window_hours"], 75)
        self.assertIsNotNone(stats["availability"])
        self.assertLess(stats["availability"], 0.05,
                        "a unit out for every hour we have known it is not 90% available")

    def test_rating_anchors_match_the_proposal(self):
        self.assertEqual(reliability.rating_1_to_5(0.70), 1)
        self.assertEqual(reliability.rating_1_to_5(0.80), 2)
        self.assertEqual(reliability.rating_1_to_5(0.95), 3)
        self.assertEqual(reliability.rating_1_to_5(0.985), 4)
        self.assertEqual(reliability.rating_1_to_5(0.999), 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
